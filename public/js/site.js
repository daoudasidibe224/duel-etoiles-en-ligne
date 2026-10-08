document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.navbar-burger').forEach((button) => {
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') === 'true'
      button.setAttribute('aria-expanded', String(!expanded))
      button.classList.toggle('is-active', !expanded)
      document.getElementById(button.dataset.target).classList.toggle('is-active', !expanded)
    })
  })
})
