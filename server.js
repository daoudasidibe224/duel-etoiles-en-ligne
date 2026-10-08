require('dotenv').config()
const mongoose = require('mongoose')
const MongoStore = require('connect-mongo').default
const { createApp } = require('./src/app')

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI doit être configuré dans .env')
  if (!process.env.SECRET || process.env.SECRET.length < 32) throw new Error('SECRET doit contenir au moins 32 caractères')
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  const store = MongoStore.create({ client: mongoose.connection.getClient(), collectionName: 'sessions' })
  const { server, io } = createApp({ secret: process.env.SECRET, store })
  server.listen(process.env.PORT || 5000, () => console.log(`Jeu disponible sur http://localhost:${process.env.PORT || 5000}`))
  let closing = false
  async function close() {
    if (closing) return
    closing = true
    io.close()
    await store.close()
    await mongoose.disconnect()
  }
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
}
if (require.main === module) start().catch((error) => { console.error(error.message); process.exitCode = 1 })
module.exports = { start }
