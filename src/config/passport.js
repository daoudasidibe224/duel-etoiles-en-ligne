const LocalStrategy = require('passport-local').Strategy
const bcrypt = require('bcryptjs')
const Utilisateur = require('../models/Utilisateur')
module.exports = (passport) => {
  passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'mdp' }, async (email, mdp, done) => {
    try {
      const utilisateur = await Utilisateur.findOne({ email: email.trim().toLowerCase() })
      if (!utilisateur || !(await bcrypt.compare(mdp, utilisateur.mdp))) return done(null, false, { message: 'Email ou mot de passe incorrect.' })
      return done(null, utilisateur)
    } catch (error) { return done(error) }
  }))
  passport.serializeUser((utilisateur, done) => done(null, utilisateur.id))
  passport.deserializeUser(async (id, done) => {
    try { done(null, await Utilisateur.findById(id)) } catch (error) { done(error) }
  })
}
