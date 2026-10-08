const { generateMessage } = require('./socketMsg')
module.exports = (discussionNsp) => {
  const users = new Map()
  const publish = () => discussionNsp.emit('roomData', { utilisateurs: [...users.values()] })
  discussionNsp.on('connection', (socket) => {
    let lastMessage = 0
    socket.on('join', (payload, callback = () => {}) => {
      if (users.has(socket.id)) return callback()
      const user = { id: socket.id, nomUtilisateur: socket.request.user.nomUtilisateur }
      users.set(socket.id, user)
      socket.emit('message', generateMessage('Accueil', `Bienvenue ${user.nomUtilisateur} !`))
      publish()
      callback()
    })
    socket.on('envoyerMessage', (message, callback = () => {}) => {
      const user = users.get(socket.id)
      if (!user || typeof message !== 'string' || !message.trim() || message.length > 1000) return callback('Le message doit contenir de 1 à 1 000 caractères.')
      if (Date.now() - lastMessage < 500) return callback('Attendez un instant avant d’envoyer un autre message.')
      lastMessage = Date.now()
      discussionNsp.emit('message', generateMessage(user.nomUtilisateur, message.trim()))
      callback()
    })
    socket.on('disconnect', () => { users.delete(socket.id); publish() })
  })
}
