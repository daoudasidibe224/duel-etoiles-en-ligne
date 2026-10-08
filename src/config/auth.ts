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

export const assurerJeu: RequestHandler = (req, res, next) => {
  if (
    req.app.identities.resolve(
      req.sessionID,
      req.user,
      req.session.guest,
      req.session.cookie.expires?.getTime(),
    )
  )
    return next();
  const target = req.originalUrl.match(/^\/salon\/salonDeJeu\/[a-f0-9-]{36}$/i);
  if (target) req.session.returnTo = target[0];
  if ((req.session.guest, req.session.cookie.expires?.getTime()))
    req.flash(
      "msg_erreur",
      "La session invitée a expiré. Choisissez un pseudo pour rejouer.",
    );
  res.redirect("/jouer");
};
