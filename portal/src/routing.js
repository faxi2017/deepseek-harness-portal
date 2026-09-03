import { config } from './config.js'

export function instanceUrl(inst) {
  if (config.instanceRouting === 'subdomains') return `https://${inst.slug}.${config.instanceDomain}`
  const url = new URL(config.portalOrigin)
  url.port = String(config.instancePortStart + inst.host_port - config.portRangeStart)
  return url.origin
}

export function instanceHostPort(localPort) {
  const offset = localPort - config.instancePortStart
  if (offset < 0 || offset > config.portRangeEnd - config.portRangeStart) return null
  return config.portRangeStart + offset
}

export function trustedInstanceRequest(req, inst, { upgrade = false } = {}) {
  const expected = new URL(instanceUrl(inst))
  if (String(req.headers.host).toLowerCase() !== expected.host.toLowerCase()) return false
  const origin = req.headers.origin
  if (origin !== undefined) return origin === expected.origin
  return !upgrade && ['GET', 'HEAD'].includes(req.method)
}
