/*
 * Copyright 2015 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

import * as childProcess from 'child_process';
import * as http from 'http';
import * as httpProxy from 'http-proxy';
import * as net from 'net';
import * as tcp from 'tcp-port-used';

import {AppSettings} from './appSettings';
import * as callbacks from './callbacks';
import * as logging from './logging';
import * as settings from './settings';
import * as util from './util';

interface JupyterServer {
  port: number;
  childProcess?: childProcess.ChildProcess;
  proxy?: httpProxy.ProxyServer;
}

/**
 * Jupyter servers key'd by user id (each server is associated with a single user)
 */
let jupyterServer: JupyterServer = null;

/**
 * Used to make sure no multiple initialization runs happen for the same user
 * at same time.
 */
const callbackManager = new callbacks.CallbackManager();

/**
 * The application settings instance.
 */
let appSettings: AppSettings;

function pipeOutput(stream: NodeJS.ReadableStream, port: number, error: boolean) {
  stream.setEncoding('utf8');

  stream.on('data', (data: string) => {
    // Jupyter generates a polling kernel message once every 3 seconds
    // per kernel! This adds too much noise into the log, so avoid
    // logging it.

    if (data.indexOf('Polling kernel') < 0) {
      logging.logJupyterOutput('[' + port + ']: ' + data, error);
    }
  });
}

function createJupyterServerAtPort(port: number) {
  const server: JupyterServer = {port};

  function exitHandler(code: number, signal: string): void {
    logging.getLogger().error('Jupyter process %d exited due to signal: %s',
                              server.childProcess.pid, signal);
    jupyterServer = null;
  }

  let args = appSettings.jupyterArgs.slice();
  // TODO(b/109975537): Remove this check.
  if (args.length === 0 || args[0] !== 'notebook') {
    args = ['notebook'].concat(args);
  }

  // We don't store notebooks on the colabx VM, but jupyter uses `notebook-dir`
  // as the default directory for kernels as well; cf:
  // https://jupyter-notebook.readthedocs.io/en/stable/config.html
  const processArgs = args.concat([
    '--port=' + server.port,
    `--FileContentsManager.root_dir="${appSettings.datalabRoot}/"`,
    `--MappingKernelManager.root_dir="${settings.getContentDir()}"`,
  ]);

  let jupyterServerAddr = 'localhost';
  for (const flag of appSettings.jupyterArgs) {
    // Extracts a string like '1.2.3.4' from the string '--ip="1.2.3.4"'
    const match = flag.match(/--ip="([^"]+)"/);
    if (match) {
      jupyterServerAddr = match[1];
      break;
    }
  }
  logging.getLogger().info(
      'Using jupyter server address %s', jupyterServerAddr);

  const notebookEnv = process.env;
  const processOptions = {
    detached: false,
    env: notebookEnv
  };

  server.childProcess = childProcess.spawn('jupyter', processArgs, processOptions);
  server.childProcess.on('exit', exitHandler);
  logging.getLogger().info('Jupyter process started with pid %d and args %j',
                           server.childProcess.pid, processArgs);

  // Capture the output, so it can be piped for logging.
  pipeOutput(server.childProcess.stdout, server.port, /* error */ false);
  pipeOutput(server.childProcess.stderr, server.port, /* error */ true);

  // Create the proxy.
  let proxyTargetHost = jupyterServerAddr;
  let proxyTargetPort = server.port;
  if (appSettings.kernelManagerProxyHost) {
    proxyTargetHost = appSettings.kernelManagerProxyHost;
  }
  if (appSettings.kernelManagerProxyPort) {
    proxyTargetPort = appSettings.kernelManagerProxyPort;
  }

  const proxyOptions: httpProxy.ProxyServerOptions = {
    target: `http://${proxyTargetHost}:${proxyTargetPort}`
  };

  server.proxy = httpProxy.createProxyServer(proxyOptions);
  server.proxy.on('proxyRes', responseHandler);
  server.proxy.on('error', errorHandler);

  tcp.waitUntilUsedOnHost(server.port, jupyterServerAddr, 100, 15000)
      .then(
          () => {
            jupyterServer = server;
            logging.getLogger().info('Jupyter server started.');
            callbackManager.invokeAllCallbacks(null);
          },
          (e) => {
            logging.getLogger().error(e, 'Failed to start Jupyter server.');
            callbackManager.invokeAllCallbacks(e);
          });
}

/**
 * Starts the Jupyter server, and then creates a proxy object enabling
 * routing HTTP and WebSocket requests to Jupyter.
 */
function createJupyterServer() {
  const port = appSettings.nextJupyterPort || 9000;

  logging.getLogger().info('Launching Jupyter server at %d', port);
  try {
    createJupyterServerAtPort(port);
  } catch (e) {
    logging.getLogger().error(e, 'Error creating the Jupyter process');
    callbackManager.invokeAllCallbacks(e);
  }
}

/** Return the port where Jupyter is serving traffic. */
export function getPort(request: http.ServerRequest): number {
  return jupyterServer ? jupyterServer.port : 0;
}

/**
 * Starts a jupyter server instance.
 */
export function start(cb: (e: Error) => void) {
  if (jupyterServer) {
    process.nextTick(() => { cb(null); });
    return;
  }

  if (!callbackManager.checkOngoingAndRegisterCallback(cb)) {
    // There is already a start request ongoing. Return now to avoid multiple Jupyter
    // processes for the same user.
    return;
  }

  logging.getLogger().info('Starting jupyter server.');
  try {
    createJupyterServer();
  }
  catch (e) {
    logging.getLogger().error(e, 'Failed to start Jupyter server.');
    callbackManager.invokeAllCallbacks(e);
  }
}

/**
 * Initializes the Jupyter server manager.
 */
export function init(settings: AppSettings): void {
  appSettings = settings;
}

/**
 * Closes the Jupyter server manager.
 */
export function close(): void {
  const jupyterProcess = jupyterServer.childProcess;

  try {
    jupyterProcess.kill('SIGHUP');
  } catch (e) {
  }

  jupyterServer = null;
}

/** Proxy this socket request to jupyter. */
export function handleSocket(request: http.ServerRequest, socket: net.Socket, head: Buffer) {
  if (!jupyterServer) {
    // should never be here.
    logging.getLogger().error('Jupyter server was not created yet.');
    return;
  }
  jupyterServer.proxy.ws(request, socket, head);
}

/** Proxy this HTTP request to jupyter. */
export function handleRequest(request: http.ServerRequest, response: http.ServerResponse) {
  if (!jupyterServer) {
    // should never be here.
    logging.getLogger().error('Jupyter server was not created yet.');
    response.statusCode = 500;
    response.end();
    return;
  }

  jupyterServer.proxy.web(request, response, null);
}

function responseHandler(proxyResponse: http.ClientResponse,
                         request: http.ServerRequest, response: http.ServerResponse) {
  const origin: string = util.headerAsString(request.headers.origin);
  if (appSettings.allowOriginOverrides.length &&
      appSettings.allowOriginOverrides.indexOf(origin) !== -1) {
    proxyResponse.headers['access-control-allow-origin'] = origin;
    proxyResponse.headers['access-control-allow-credentials'] = 'true';
  } else if (proxyResponse.headers['access-control-allow-origin'] !== undefined) {
    // Delete the allow-origin = * header that is sent (likely as a result of a workaround
    // notebook configuration to allow server-side websocket connections that are
    // interpreted by Jupyter as cross-domain).
    delete proxyResponse.headers['access-control-allow-origin'];
  }

  if (proxyResponse.statusCode !== 200) {
    return;
  }
}

function errorHandler(error: Error, request: http.ServerRequest, response: http.ServerResponse) {
  logging.getLogger().error(error, 'Jupyter server returned error.');

  response.writeHead(500, 'Internal Server Error');
  response.end();
}
