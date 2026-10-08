module.exports = (salonNsp, salons) => {
  salonNsp.on('connection', (socket) => {
    socket.on('join', (payload, callback = () => {}) => {
      // Les salons vides abandonnés expirent après dix minutes.
      for (const [id, salon] of Object.entries(salons)) if (!salon.utilisateurs.length && Date.now() - salon.createdAt > 600000) delete salons[id]
      socket.emit('majSalonDeJeu', salons)
      callback()
    })
  })
}
