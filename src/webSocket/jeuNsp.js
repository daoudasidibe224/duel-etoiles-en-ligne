const Score = require('../models/Score')
module.exports = (jeuNsp, salonNsp, salons) => {
  jeuNsp.on('connection', (socket) => {
    let utilisateur
    let saved = false
    socket.on('join', (payload = {}, callback = () => {}) => {
      if (utilisateur) return callback('Vous avez déjà rejoint une partie.')
      const room = typeof payload.room === 'string' ? payload.room : ''
      const salon = salons[room]
      if (!salon || salon.utilisateurs.length >= 2 || salon.utilisateurs.some((user) => user.userId === socket.request.user.id)) return callback('Salon fermé, complet ou déjà rejoint.')
      utilisateur = { id: socket.id, userId: socket.request.user.id, nomUtilisateur: socket.request.user.nomUtilisateur, room }
      salon.utilisateurs.push(utilisateur)
      socket.join(room)
      jeuNsp.to(room).emit('roomData', { room, utilisateurs: salon.utilisateurs })
      salonNsp.emit('majSalonDeJeu', salons)
      callback()
    })
    socket.on('afficherBtnPlay', () => {
      const salon = utilisateur && salons[utilisateur.room]
      if (salon?.utilisateurs.length === 2) jeuNsp.to(salon.utilisateurs[0].id).emit('afficherBtnPlay', salon.utilisateurs[0].id)
    })
    socket.on('startGame', () => {
      const salon = utilisateur && salons[utilisateur.room]
      if (!salon || salon.started || salon.utilisateurs.length !== 2 || salon.utilisateurs[0].id !== socket.id) return
      salon.started = true
      salon.startedAt = Date.now()
      jeuNsp.to(utilisateur.room).emit('init')
      jeuNsp.to(utilisateur.room).emit('etoiles')
    })
    socket.on('deplacementMonJoueur', (sprite) => {
      if (!utilisateur || !salons[utilisateur.room]?.started || !sprite?.etat) return
      const etat = {}
      for (const key of ['runningRight', 'runningLeft', 'idLeft', 'idRight', 'dead']) etat[key] = sprite.etat[key] === true
      socket.to(utilisateur.room).emit('deplacementMonJoueur', { id: socket.id, etat })
    })
    socket.on('score', (sprite) => {
      if (!utilisateur || !salons[utilisateur.room]?.started || !Number.isInteger(sprite?.score) || sprite.score < 0 || sprite.score > 10000) return
      socket.to(utilisateur.room).emit('score', { id: socket.id, score: sprite.score })
    })
    socket.on('scoreFinDeJeu', async (payload, callback = () => {}) => {
      const salon = utilisateur && salons[utilisateur.room]
      const adversaire = salon?.utilisateurs.find((user) => user.id !== socket.id)
      if (!salon?.started || saved || !adversaire || ![payload?.monScore, payload?.scoreAutreJoueur].every((value) => Number.isInteger(value) && value >= 0 && value <= 10000)) return callback('Score invalide.')
      saved = true
      try {
        await Score.create({ monJoueurId: socket.request.user.id, monNom: utilisateur.nomUtilisateur, monScore: payload.monScore, nomUtilisateurAutreJoueur: adversaire.nomUtilisateur, scoreAutreJoueur: payload.scoreAutreJoueur })
        callback()
      } catch { saved = false; callback('Le score n’a pas pu être enregistré.') }
    })
    socket.on('disconnect', () => {
      if (!utilisateur) return
      const salon = salons[utilisateur.room]
      if (!salon) return
      salon.utilisateurs = salon.utilisateurs.filter((user) => user.id !== socket.id)
      jeuNsp.to(utilisateur.room).emit('roomData', { room: utilisateur.room, utilisateurs: salon.utilisateurs })
      if (!salon.utilisateurs.length) delete salons[utilisateur.room]
      salonNsp.emit('majSalonDeJeu', salons)
    })
  })
}
