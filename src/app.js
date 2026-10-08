const path = require('node:path')
const crypto = require('node:crypto')
const express = require('express')
const helmet = require('helmet')
const passport = require('passport')
const session = require('express-session')
const flash = require('connect-flash')
const { Server } = require('socket.io')

function createApp({ secret, store } = {}) {
  if (!secret || secret.length < 32) throw new Error('Un secret de session de 32 caractères minimum est nécessaire')
  const app = express()
  const server = require('node:http').createServer(app)
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (req, callback) => {
      const origin = req.headers.origin
      try { callback(null, !origin || new URL(origin).host === req.headers.host) }
      catch { callback(null, false) }
    },
  })
  app.disable('x-powered-by')
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)
  // Les vues historiques utilisent quelques scripts intégrés au document.
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  const sessionMiddleware = session({
    name: 'run.sid', secret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 },
  })
  require('./config/passport')(passport)
  const initialize = passport.initialize()
  const authenticate = passport.session()
  app.use(sessionMiddleware, initialize, authenticate, flash())
  const handshakeOnly = (middleware) => (req, res, next) => req._query.sid === undefined ? middleware(req, res, next) : next()
  io.engine.use(handshakeOnly(sessionMiddleware))
  io.engine.use(handshakeOnly(initialize))
  io.engine.use(handshakeOnly(authenticate))
  const authorizeSocket = (socket, next) => socket.request.user ? next() : next(new Error('Connexion nécessaire'))
  for (const name of ['/', '/jeu', '/discussion']) io.of(name).use(authorizeSocket)
  app.io = io
  app.salons = Object.create(null)
  require('./webSocket/indexSocket')({ io, salons: app.salons })
  app.set('views', path.join(__dirname, '../public/views'))
  app.set('view engine', 'pug')
  for (const [url, folder] of Object.entries({ images: 'assets/images', js: 'js', sons: 'assets/sons', sprites: 'assets/sprites', tilesets: 'assets/tilesets', styles: 'assets/styles' })) {
    app.use(`/${url}`, express.static(path.join(__dirname, '../public', folder)))
  }
  app.use((req, res, next) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex')
    res.locals.csrfToken = req.session.csrfToken
    res.locals.utilisateur = req.user
    for (const name of ['msg_succes', 'msg_erreur', 'error']) res.locals[name] = req.flash(name)
    if (req.method === 'POST' && req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Le formulaire a expiré. Rechargez la page.')
    next()
  })
  app.use('/', require('./routes/index'))
  app.use('/utilisateur', require('./routes/utilisateur'))
  app.use('/salon', require('./routes/salon'))
  app.use((req, res) => res.status(404).render('erreur', { titre: 'Page introuvable', message: 'Ce lien ne mène à aucune page du jeu.' }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    console.error(error.message)
    res.status(500).render('erreur', { titre: 'Une erreur est survenue', message: 'Réessayez dans quelques instants.' })
  })
  return { app, server, io }
}
module.exports = { createApp }
