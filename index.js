const fs = require('fs')
const { Eureka } = require('eureka-js-client')
const mustache = require('mustache')
const chokidar = require('chokidar')
const isEqual = require('lodash.isequal')
const flattern = require('lodash.flatten')
const protobuf = require('@grpc/proto-loader')
const grpcLibrary = require('@grpc/grpc-js')
const glob = require('glob')
const axios = require('axios')

const template = fs.readFileSync('./template.yaml.mustache', 'utf8')

let cachedServices = []
let cachedStreams = []

const packageDefinition = protobuf.loadSync(glob.sync('node_modules/@quancheng/**/*.proto'))

const servicesFromProto = Object.keys(packageDefinition)
  .filter((name) => name.indexOf('.service.') > -1)
  .map((name) => ({
    name,
    methods: Object.keys(packageDefinition[name])
  }))

const transformAppNameToHost = (name) => `${name.replace(/\.|\:/gi, '-')}.grpc`

const generateUpstreamObj = (appName, app) => {
  return {
    name: transformAppNameToHost(appName),
    targets: app.map((instance) => `${instance.ipAddr}:${instance.port.$ + 1}`)
  }
}

const generateServiceObj = (appName, app) => {
  const [serviceName, version] = appName.split(':')
  return {
    name: serviceName.toLowerCase(),
    host: transformAppNameToHost(appName),
    routes: generateRouteObj(appName)
  }
}

const generateRouteObj = (appName) => {
  const [serviceName, version] = appName.split(':')
  const [keyName] = serviceName.split('-')
  const serviceMatched = servicesFromProto.filter((s) => s.name.includes(`.${keyName.toLowerCase()}.`))

  if (!serviceMatched) return []
  return flattern(
    serviceMatched.map((s) =>
      s.methods.map((m) => ({
        name: `${transformAppNameToHost(appName)}-${m}`,
        servicePath: `${s.name}/${m}`
      }))
    )
  )
}

const client = new Eureka({
  eureka: {
    serviceUrls: {
      default: ['http://eureka.dev.quancheng-ec.com/eureka/apps/']
    },
    heartbeatInterval: 5000,
    registryFetchInterval: 3000,
    registerWithEureka: false
  }
})

client.logger.level('debug')

client.start((err) => {
  if (err) {
    process.exit(1)
  }
})

chokidar.watch('./config.yaml').on('all', (event, path) => {
  console.log(event, path)
})

client.on('registryUpdated', () => {
  console.log('tick')
  const appNameList = Object.keys(client.cache.app)
  let services = []
  let upstreams = []
  appNameList.forEach((appName) => {
    const s = generateServiceObj(appName, client.cache.app[appName])
    if (s.routes.length > 0) {
      services.push(s)
    }
    upstreams.push(generateUpstreamObj(appName, client.cache.app[appName]))
  })
  const isConfigEqual = isEqual({ services, upstreams }, { services: cachedServices, upstreams: cachedStreams })
  if (!isConfigEqual) {
    const rendered = mustache.render(template, { services, upstreams })
    fs.writeFile('./config.yaml', rendered, { encoding: 'utf8' }, () => {
      console.log('file written')
      cachedServices = services
      cachedStreams = upstreams
      axios
        .post(`http://${process.env.KONG_HOST || '0.0.0.0'}:8001/config`, {
          config: rendered
        })
        .catch(console.error)
    })
  } else {
    services = null
    upstreams = null
  }
})
