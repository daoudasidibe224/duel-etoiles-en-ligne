/* eslint-disable consistent-return */
module.exports = {
  // s'assurer que l'utilisateur est authentifié
  assurerAuthentification(req, res, next) {
    if (req.isAuthenticated()) {
      return next()
    }

    req.flash('msg_erreur', 'Veuillez vous connecter pour voir cette page')
    res.redirect('/connexion')
  },
  // Authentifié
  authentifie(req, res, next) {
    if (!req.isAuthenticated()) {
      return next()
    }
    // si l'authentifacation reussi redirection vers le salon
    res.redirect('/salon')
  },
}
