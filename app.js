/* app.js — orchestrateur (remplace l'ancien fichier unique)
   index.html et sw.js ne changent pas.
   Ordre d'import garanti : parser → engine → map             */
import './parser.js';
import './engine.js';
import './map.js';
