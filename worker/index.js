/** Open Room ETHZ: Cloudflare Worker entry point.
 *   - Static files (public/) are served by Workers Static Assets without running this code.
 *   - Only /api/* runs the Worker, which forwards to ONE global, SQLite-backed Durable Object (the ETH gateway).
 * Business logic lives in lib/allocations-core.js (shared with the Node dev server) and worker/gateway.js. */
import {DurableObject} from 'cloudflare:workers';
import {Gateway, gatewayConfig} from './gateway.js';
import {route, resolveEndpoint} from './router.js';

export class EthGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.gateway = new Gateway({sql: ctx.storage.sql, cfg: gatewayConfig(env, resolveEndpoint(env))});
  }
  allocations(room, from, to) { return this.gateway.handleAllocations(room, from, to); }
  status() { return this.gateway.status(); }
}

export default {
  fetch(request, env) { return route(request, env); }
};
