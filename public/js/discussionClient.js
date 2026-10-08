const discussionClient = io('/discussion')
const status = document.getElementById('chat-status')
const form = document.getElementById('envoyerMessage')
const input = document.getElementById('message')
const button = form.querySelector('button')
discussionClient.on('connect', () => { status.textContent = 'Vous êtes en ligne.'; discussionClient.emit('join', {}, () => {}) })
discussionClient.on('disconnect', () => { status.textContent = 'Connexion interrompue. Vos messages ne sont pas envoyés.' })
discussionClient.on('connect_error', () => { status.textContent = 'Connexion impossible. Rechargez la page.' })
discussionClient.on('roomData', ({ utilisateurs }) => {
  const list = document.getElementById('listeUtilisateurs')
  list.replaceChildren()
  for (const user of utilisateurs) {
    const row = document.createElement('p')
    row.textContent = user.nomUtilisateur
    list.append(row)
  }
})
discussionClient.on('message', (message) => {
  const chat = document.querySelector('.chatBox')
  const row = document.createElement('article')
  row.className = 'chat-message'
  const info = document.createElement('p')
  info.className = 'chat-meta'
  info.textContent = `${message.nomUtilisateur} · ${new Date(message.heureDenvoi).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
  const text = document.createElement('p')
  text.textContent = message.text
  row.append(info, text)
  chat.append(row)
  // La discussion reste légère pendant les longues sessions.
  while (chat.children.length > 200) chat.firstChild.remove()
  chat.scrollTop = chat.scrollHeight
})
form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!discussionClient.connected || !input.value.trim()) return
  button.disabled = true
  discussionClient.timeout(5000).emit('envoyerMessage', input.value, (timeout, error) => {
    button.disabled = false
    if (timeout || error) { status.textContent = error || 'Le message n’a pas été envoyé. Réessayez.'; return }
    input.value = ''
    status.textContent = 'Message envoyé.'
    input.focus()
  })
})
