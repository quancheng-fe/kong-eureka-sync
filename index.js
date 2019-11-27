const fs = require('fs')
const path = require('path')
const { Eureka } = require('eureka-js-client')
const mustache = require('mustache')
const chokidar = require('chokidar')
const isEqual = require('lodash.isequal')
const flattern = require('lodash.flatten')
const protobuf = require('@grpc/proto-loader')
const grpcLibrary = require('@grpc/grpc-js')
const glob = require('glob')
const axios = require('axios')
const Express = require('express')
const jsyaml = require('js-yaml')

const template = fs.readFileSync('./template.yaml.mustache', 'utf8')
const server = Express()

server.get('/config', (req, res) => {
  fs.readFile(path.join(__dirname, 'config.yaml'), 'utf8', (err, str) => {
    if (err) {
      throw err
    }

    const config = jsyaml.safeLoad(str)
    res.send(config)
  })
})

let cachedServices = []
let cachedStreams = []

const packageDefinition = protobuf.loadSync(glob.sync('node_modules/@quancheng/**/*.proto'))

const servicesFromProto = Object.keys(packageDefinition)
  .filter((name) => name.indexOf('.service.') > -1)
  .map((name) => ({
    name,
    methods: Object.keys(packageDefinition[name])
  }))

const transformAppName = (name, ...others) => `${name.replace(/\.|\:/gi, '-')}${others.join('')}`

const generateUpstreamObj = (appName, app) => {
  return {
    name: transformAppName(appName, '-grpc'),
    targets: app.map((instance) => `${instance.ipAddr}:${instance.port.$ + 1}`)
  }
}

const generateServiceObj = (appName, app) => {
  const [serviceName, version] = appName.split(':')
  return {
    name: serviceName.toLowerCase(),
    host: transformAppName(appName, '.grpc'),
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
        name: `${transformAppName(appName)}-${m}`,
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

client.start((err) => {
  if (err) {
    process.exit(1)
  }
  console.log('eureka client started')

  server.listen(process.env.PORT || 3233, () => {
    console.log('server started')
  })
})

chokidar.watch('./config.yaml').on('all', (event, path) => {
  console.log(event, path)
})

client.on('registryUpdated', () => {
  console.log('eureka registry updated')
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
