const salonClient = io()
const partieDisponible = document.querySelector('.partieDisponible')
const status = document.getElementById('connection-status')
salonClient.on('connect', () => { status.textContent = 'En ligne'; salonClient.emit('join', {}, () => {}) })
salonClient.on('disconnect', () => { status.textContent = 'Connexion interrompue' })
salonClient.on('connect_error', () => { status.textContent = 'Connexion impossible. Rechargez la page.' })
salonClient.on('majSalonDeJeu', (salons) => {
  partieDisponible.replaceChildren()
  const disponibles = Object.values(salons).filter((salon) => salon.utilisateurs.length < 2 && !salon.started)
  if (!disponibles.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    const title = document.createElement('h3')
    title.textContent = 'La piste est libre.'
    const text = document.createElement('p')
    text.textContent = 'Aucune partie en attente. Ouvrez votre salon et invitez un ami.'
    empty.append(title, text)
    partieDisponible.append(empty)
  }
  for (const salon of disponibles) {
    const row = document.createElement('article')
    row.className = 'room-row'
    const title = document.createElement('p')
    title.textContent = `Salon de ${salon.nomProprietaire}`
    const count = document.createElement('span')
    count.textContent = `${salon.utilisateurs.length}/2 joueurs`
    const link = document.createElement('a')
    link.className = 'button is-outlined'
    link.href = `/salon/salonDeJeu/${encodeURIComponent(salon.id)}`
    link.textContent = 'Rejoindre →'
    row.append(title, count, link)
    partieDisponible.append(row)
  }
})
