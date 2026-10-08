import type { RequestHandler } from "express";
export const assurerAuthentification: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  req.flash("msg_erreur", "Veuillez vous connecter pour voir cette page");
  res.redirect("/connexion");
};
export const authentifie: RequestHandler = (req, res, next) => {
  if (!req.isAuthenticated()) return next();
  res.redirect("/salon");
};
