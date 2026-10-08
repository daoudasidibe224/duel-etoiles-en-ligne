import { Strategy } from "passport-local";
import bcrypt from "bcryptjs";
import type { PassportStatic } from "passport";
import Utilisateur from "../models/Utilisateur";
export default function configurePassport(passport: PassportStatic) {
  passport.use(
    new Strategy(
      { usernameField: "email", passwordField: "mdp" },
      async (email, mdp, done) => {
        try {
          const utilisateur = await Utilisateur.findOne({
            email: email.trim().toLowerCase(),
          });
          if (!utilisateur || !(await bcrypt.compare(mdp, utilisateur.mdp)))
            return done(null, false, {
              message: "Email ou mot de passe incorrect.",
            });
          done(null, utilisateur);
        } catch (error) {
          done(error);
        }
      },
    ),
  );
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: string, done) => {
    try {
      done(null, await Utilisateur.findById(id));
    } catch (error) {
      done(error);
    }
  });
}
