const router = require('express').Router()
const { authentifie, assurerAuthentification } = require('../config/auth')
const Score = require('../models/Score')
router.get('/', (req, res) => res.redirect('/connexion'))
router.get('/connexion', authentifie, (req, res) => res.render('connexion'))
router.get('/inscription', authentifie, (req, res) => res.render('inscription'))
router.get('/stats', assurerAuthentification, async (req, res) => {
  // Le nom couvre aussi les scores historiques sans identifiant utilisateur.
  const filter = { $or: [{ monJoueurId: req.user._id }, { monJoueurId: { $exists: false }, monNom: req.user.nomUtilisateur }] }
  const [lesScores, meilleurScore, total] = await Promise.all([Score.find(filter).sort({ date: -1 }).limit(100), Score.find(filter).sort({ monScore: -1 }).limit(1), Score.countDocuments(filter)])
  res.render('statsJoueur', { lesScores, meilleurScore, total })
})
router.get('/profil', assurerAuthentification, (req, res) => res.render('profil'))
module.exports = router
