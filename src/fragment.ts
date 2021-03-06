import fetch from "node-fetch";
import {HandlerDataResponse, IFragmentContentResponse} from "./types";
import {CONTENT_ENCODING_TYPES, FRAGMENT_RENDER_MODES} from "./enums";
import * as querystring from "querystring";
import {DEBUG_QUERY_NAME, DEFAULT_CONTENT_TIMEOUT, PREVIEW_PARTIAL_QUERY_NAME, RENDER_MODE_QUERY_NAME} from "./config";
import {IExposeFragment, IFragment, IFragmentBFF, IFragmentHandler} from "./types";
import url from "url";
import path from "path";
import {container, TYPES} from "./base";
import {Logger} from "./logger";
import {decompress} from "iltorb";
import {HttpClient} from "./client";


const logger = <Logger>container.get(TYPES.Logger);
const httpClient = <HttpClient>container.get(TYPES.Client);

export class Fragment {
  name: string;

  constructor(config: IFragment) {
    this.name = config.name;
  }
}

export class FragmentBFF extends Fragment {
  public config: IFragmentBFF;
  private handler: { [version: string]: IFragmentHandler } = {};

  constructor(config: IFragmentBFF) {
    super({name: config.name});
    this.config = config;

    this.prepareHandlers();
  }

  /**
   * Renders fragment: data -> content
   * @param {object} req
   * @param res
   * @param {string} version
   * @returns {Promise<HandlerDataResponse>}
   */
  async render(req: object, res: any, version?: string): Promise<HandlerDataResponse> {
    const targetVersion = version || this.config.version;
    const handler = this.handler[targetVersion];
    const clearedRequest = this.clearRequest(req);
    if (handler) {
      if (handler.data) {
        const dataResponse = await handler.data(clearedRequest);
        if (dataResponse.data) {
          const renderedPartials = handler.content(clearedRequest, dataResponse.data);
          delete dataResponse.data;
          return {
            ...renderedPartials,
            ...dataResponse
          };
        } else {
          return dataResponse;
        }
      } else {
        throw new Error(`Failed to find data handler for fragment. Fragment: ${this.config.name}, Version: ${version || this.config.version}`);
      }
    } else {
      throw new Error(`Failed to find fragment version. Fragment: ${this.config.name}, Version: ${version || this.config.version}`);
    }
  }

  /**
   * Renders placeholder
   * @param {object} req
   * @param {string} version
   * @returns {string}
   */
  placeholder(req: object, version?: string) {
    const fragmentVersion = (version && this.config.versions[version]) ? version : this.config.version;
    const handler = this.handler[fragmentVersion];
    if (handler) {
      return handler.placeholder();
    } else {
      throw new Error(`Failed to find fragment version. Fragment: ${this.config.name}, Version: ${version || this.config.version}`);
    }
  }

  /**
   * Purifies req.path, req.query from Puzzle elements.
   * @param req
   * @returns {*}
   */
  private clearRequest(req: any) {
    const clearedReq = Object.assign({}, req);
    if (req.query) {
      delete clearedReq.query[RENDER_MODE_QUERY_NAME];
      delete clearedReq.query[PREVIEW_PARTIAL_QUERY_NAME];
      delete clearedReq.query[DEBUG_QUERY_NAME];
    }
    if (req.path) {
      clearedReq.path = req.path.replace(`/${this.name}`, '');
    }
    return clearedReq;
  }

  /**
   * Reolves handlers based on configuration
   */
  private prepareHandlers() {
    Object.keys(this.config.versions).forEach(version => {
      const configurationHandler = this.config.versions[version].handler;
      if (configurationHandler) {
        this.handler[version] = configurationHandler;
      } else {
        const module = require(path.join(process.cwd(), `/src/fragments/`, this.config.name, version));
        this.handler[version] = module;
      }
    });
  }
}

export class FragmentStorefront extends Fragment {
  config: IExposeFragment | undefined;
  primary = false;
  shouldWait = false;
  from: string;
  public fragmentUrl: string | undefined;
  public assetUrl: string | undefined;

  constructor(name: string, from: string) {
    super({name});

    this.from = from;
  }

  /**
   * Updates fragment configuration
   * @param {IExposeFragment} config
   * @param {string} gatewayUrl
   * @param {string | undefined} assetUrl
   */
  update(config: IExposeFragment, gatewayUrl: string, assetUrl?: string | undefined) {
    if (assetUrl) {
      this.assetUrl = url.resolve(assetUrl, this.name);
    }
    this.fragmentUrl = url.resolve(gatewayUrl, this.name);

    this.config = config;
  }

  /**
   * Returns fragment placeholder as promise, fetches from gateway
   * @returns {Promise<string>}
   */
  async getPlaceholder(): Promise<string> {
    if (!this.config) {
      logger.error(new Error(`No config provided for fragment: ${this.name}`));
      return '';
    }

    if (!this.config.render.placeholder) {
      logger.error(new Error('Placeholder is not enabled for fragment'));
      return '';
    }

    return fetch(`${this.fragmentUrl}/placeholder`)
      .then(res => res.text())
      .then(html => {
        return html;
      })
      .catch(err => {
        logger.error(`Failed to fetch placeholder for fragment: ${this.fragmentUrl}/placeholder`, err);
        return '';
      });
  }

  /**
   * Fetches fragment content as promise, fetches from gateway
   * Returns {
     *  html: {
     *    Partials
     *  },
     *  status: gateway status response code
     * }
   * @param attribs
   * @param req
   * @returns {Promise<IFragmentContentResponse>}
   */
  async getContent(attribs: any = {}, req?: { url: string, headers: { [name: string]: string } }): Promise<IFragmentContentResponse> {
    if (!this.config) {
      logger.error(new Error(`No config provided for fragment: ${this.name}`));
      return {
        status: 500,
        html: {},
        headers: {},
        model: {}
      };
    }

    let query = {
      ...attribs,
      __renderMode: FRAGMENT_RENDER_MODES.STREAM
    };

    let parsedRequest;
    let requestConfiguration: any = {
      timeout: this.config.render.timeout || DEFAULT_CONTENT_TIMEOUT,
    };

    if (req) {
      if (req.url) {
        parsedRequest = url.parse(req.url, true) as { pathname: string, query: object };
        query = {
          ...query,
          ...parsedRequest.query,
        };
      }
      if (req.headers) {
        requestConfiguration.headers = req.headers;
        requestConfiguration.headers.originalUrl = req.url;
      }
    }


    delete query.from;
    delete query.name;
    delete query.partial;
    delete query.primary;
    delete query.shouldwait;

    const routeRequest = req && parsedRequest ? `${parsedRequest.pathname.replace('/' + this.name, '')}?${querystring.stringify(query)}` : `/?${querystring.stringify(query)}`;

    return httpClient.get(`${this.fragmentUrl}${routeRequest}`, {json: true, ...requestConfiguration}).then(res => {
      return {
        status: res.data.$status || res.response.statusCode,
        headers: res.data.$headers || {},
        html: res.data,
        model: res.data.$model || {}
      };
    }).catch(err => {
      logger.error(`Failed to get contents for fragment: ${this.name}`, err);
      return {
        status: 500,
        html: {},
        headers: {},
        model: {}
      };
    });
  }

  /**
   * Returns asset content
   * @param {string} name
   * @returns {Promise<string>}
   */
  async getAsset(name: string) {
    if (!this.config) {
      logger.error(new Error(`No config provided for fragment: ${this.name}`));
      return null;
    }

    const asset = this.config.assets.find(asset => asset.name === name);
    if (!asset) {
      logger.error(new Error(`Asset not declared in fragments asset list: ${name}`));
      return null;
    }

    return fetch(asset.link || `${this.fragmentUrl}/static/${asset.fileName}`).then(async res => {
      const encoding = res.headers.get('content-encoding');

      switch (encoding) {
        case CONTENT_ENCODING_TYPES.BROTLI:
          return await decompress(await res.buffer());
        default:
          return await res.text();
      }
    }).catch(e => {
      logger.error(new Error(`Failed to fetch asset from gateway: ${this.fragmentUrl}/static/${asset.fileName}`));
      return null;
    });
  }

  /**
   * Returns asset path
   * @param {string} name
   * @returns {string}
   */
  getAssetPath(name: string) {
    if (!this.config) {
      logger.error(new Error(`No config provided for fragment: ${this.name}`));
      return null;
    }

    const asset = this.config.assets.find(asset => asset.name === name);

    if (!asset) {
      logger.error(new Error(`Asset not declared in fragments asset list: ${name}`));
      return null;
    }

    return asset.link || `${this.assetUrl || this.fragmentUrl}/static/${asset.fileName}`;
  }
}

