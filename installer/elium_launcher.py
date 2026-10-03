"""
Elium Launcher — Point d'entrée principal de l'application installée.

Lance un serveur HTTP local servant le Web Studio pré-buildé, puis ouvre une
fenêtre application dédiée (Edge/Chrome en mode --app : pas de barre d'adresse,
pas d'onglets, profil séparé du navigateur personnel). À la fermeture de la
fenêtre, le serveur s'arrête proprement. Si aucun navigateur compatible n'est
trouvé, repli sur un onglet du navigateur par défaut.

Usage : Elium.exe [fichier.elium]
        Le fichier passé en argument (association Windows) est ouvert au
        démarrage via l'endpoint local /__open__.
"""

import hmac
import http.server
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser
from functools import partial
from html import escape as _html_escape
from pathlib import Path
from typing import Optional

# Module d'auto-update (embarqué à côté du lanceur, cf. installer/elium.spec).
# Import tolérant : si absent/cassé, l'app tourne normalement, sans màj.
try:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import updater  # type: ignore
except Exception:  # pragma: no cover - défensif
    updater = None  # type: ignore


# --------------------------------------------------------------------------- #
# Anti-CSRF sur les routes d'état (démarrage/redémarrage de mise à jour, rollback)
#
# Le serveur loopback écoute sur un port PRÉVISIBLE (3000-3100, cf. find_free_port)
# et sans authentification réseau : sans ce jeton, n'importe quelle page web
# ouverte pendant qu'Elium tourne pourrait forcer un rollback/redémarrage par un
# simple fetch() en croisant les ports. Défense :
#   1) Un jeton ALÉATOIRE généré à chaque lancement du process (_SESSION_TOKEN),
#      injecté UNIQUEMENT dans le document HTML servi par CE process (une balise
#      <meta>, jamais un script inline — la CSP stricte l'interdirait, cf.
#      _serve_index_with_banner). Une page tierce ne peut ni le lire (Same-Origin
#      Policy : elle ne peut pas fetch()/parser ce document depuis une autre
#      origine) ni le deviner. Exigé en en-tête X-Elium-Token sur do_POST.
#   2) En défense supplémentaire : vérification Origin (ou Host à défaut) ==
#      127.0.0.1:<port> de CE serveur.
# Les deux DOIVENT passer pour qu'une route d'état soit honorée.
_SESSION_TOKEN = secrets.token_urlsafe(32)


def _token_meta_tag() -> bytes:
    """Balise <meta> portant le jeton de session, à injecter dans le document servi."""
    return (
        b'<meta name="elium-token" content="'
        + _html_escape(_SESSION_TOKEN, quote=True).encode("ascii")
        + b'">'
    )


def _is_authorized_state_request(
    token: Optional[str], origin: Optional[str], host: Optional[str], port: int
) -> bool:
    """True si une requête POST vers une route d'état est légitime.

    `token` doit correspondre EXACTEMENT (comparaison à temps constant) au jeton
    de CETTE session. `origin`, quand le navigateur l'envoie (cas normal pour un
    fetch POST), doit désigner ce serveur ; à défaut on retombe sur `Host` (qui,
    lui, est toujours présent en HTTP/1.1).
    """
    if not hmac.compare_digest(token or "", _SESSION_TOKEN):
        return False
    expected = f"http://127.0.0.1:{port}"
    if origin is not None:
        return origin == expected
    return (host or "") == f"127.0.0.1:{port}"


# Carte de mise à jour : une seule carte discrète, un seul bouton, une barre animée.
# Servie en fichiers EXTERNES (/__elium_update.css + .js) pour respecter la CSP stricte
# (style-src 'self' + script-src 'self') — pas de styles/scripts inline.
UPDATE_CSS = """
#elium-upd {
  position: fixed; right: 24px; bottom: 24px;
  z-index: var(--el-z-toast, 2147483000);
  width: 366px; max-width: calc(100vw - 40px);
  background: var(--el-surface, #ffffff);
  color: var(--el-text, #0f172a);
  border: 1px solid var(--el-border, #e2e8f0);
  border-radius: var(--el-radius-xl, 16px);
  box-shadow: var(--el-elev-5, 0 20px 48px rgba(15,23,42,.18));
  font-family: var(--el-font, "Inter", system-ui, "Segoe UI", Roboto, sans-serif);
  padding: 18px 18px 16px; display: none; overflow: hidden;
}
#elium-upd.show { display: block; animation: elium-upd-in .3s var(--el-ease-spring, cubic-bezier(.34,1.56,.64,1)); }
#elium-upd::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: linear-gradient(90deg, var(--el-blue-400, #60a5fa), var(--el-blue-700, #1d4ed8));
}
#elium-upd.ready::before {
  background: linear-gradient(90deg, var(--el-green-400, #4ade80), var(--el-green-600, #16a34a));
}
#elium-upd.err::before {
  background: linear-gradient(90deg, var(--el-amber-500, #f59e0b), var(--el-red-600, #dc2626));
}
.elium-upd-head { display: flex; align-items: center; gap: 12px; }
.elium-upd-badge {
  width: 42px; height: 42px; flex: none; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; font-size: 21px;
  background: var(--el-primary-50, #eff6ff); color: var(--el-primary, #1d4ed8);
}
#elium-upd.ready .elium-upd-badge { background: var(--el-seal-bg, #f0fdf4); color: var(--el-seal, #16a34a); }
#elium-upd.err .elium-upd-badge { background: var(--el-warning-bg, #fffbeb); color: var(--el-warning, #b45309); }
.elium-upd-txt { flex: 1; min-width: 0; }
.elium-upd-title { font-weight: 700; font-size: 15px; letter-spacing: -.01em; }
.elium-upd-sub { color: var(--el-text-soft, #475569); font-size: 12.5px; margin-top: 3px; line-height: 1.4; }
.elium-upd-track {
  height: 8px; border-radius: 999px; overflow: hidden; margin-top: 16px;
  background: var(--el-surface-3, #f1f5f9);
}
.elium-upd-bar {
  height: 100%; width: 0%; border-radius: 999px;
  background: linear-gradient(90deg, var(--el-blue-400, #60a5fa), var(--el-blue-700, #1d4ed8));
  transition: width .3s ease;
}
.elium-upd-bar.indet { width: 35%; animation: elium-upd-slide 1.1s ease-in-out infinite; }
@keyframes elium-upd-slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
.elium-upd-btn {
  margin-top: 16px; width: 100%; border: 0; cursor: pointer;
  background: var(--el-primary-btn, #1d4ed8); color: var(--el-primary-contrast, #fff);
  border-radius: var(--el-radius-md, 8px); padding: 11px 14px;
  font-weight: 700; font-size: 14px; font-family: inherit;
  box-shadow: var(--el-elev-1, 0 1px 2px rgba(15,23,42,.06));
  transition: background .14s ease, transform .14s ease;
}
.elium-upd-btn:hover { background: var(--el-primary-hover, #1e40af); }
.elium-upd-btn:active { transform: translateY(1px); }
.elium-upd-btn:disabled { opacity: .6; cursor: default; }
#elium-upd.ready .elium-upd-btn { background: var(--el-seal, #16a34a); }
.elium-upd-later {
  margin-top: 8px; width: 100%; background: none; border: 0;
  color: var(--el-text-muted, #586675); font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.elium-upd-later:hover { color: var(--el-text-soft, #475569); text-decoration: underline; }
/* Nouveautés : ce que la mise à jour apporte, replié par défaut pour que la
   carte reste discrète, et déroulant sur toutes les versions non installées. */
.elium-upd-more {
  margin-top: 12px; width: 100%; background: none; cursor: pointer; font-family: inherit;
  border: 1px solid var(--el-border, #e2e8f0); border-radius: var(--el-radius-md, 8px);
  color: var(--el-text-soft, #475569); font-size: 12.5px; font-weight: 600;
  padding: 8px 12px; display: none; align-items: center; justify-content: center; gap: 6px;
  transition: background .14s ease, border-color .14s ease;
}
.elium-upd-more.on { display: flex; }
.elium-upd-more:hover { background: var(--el-surface-2, #f8fafc); border-color: var(--el-border-strong, #cbd5e1); }
/* `inline-block` explicite : le bouton étant `display: flex`, le chevron est de
   toute façon blockifié, mais l'écrire garde la rotation valide si le bouton
   cessait d'être flex — `transform` ne s'applique pas à un inline non remplacé. */
.elium-upd-more .chev { display: inline-block; transition: transform .18s ease; font-size: 10px; }
.elium-upd-more.open .chev { transform: rotate(180deg); }
.elium-upd-notes {
  display: none; margin-top: 10px; max-height: 216px; overflow-y: auto;
  border-top: 1px solid var(--el-border, #e2e8f0); padding-top: 10px;
  font-size: 12.5px; line-height: 1.5; color: var(--el-text-soft, #475569);
  overscroll-behavior: contain;
}
.elium-upd-notes.open { display: block; }
.elium-upd-relv {
  font-weight: 700; color: var(--el-text, #0f172a); font-size: 12px;
  margin: 10px 0 4px; display: flex; align-items: baseline; gap: 8px;
}
.elium-upd-notes .elium-upd-relv:first-child { margin-top: 0; }
.elium-upd-reld { font-weight: 500; color: var(--el-text-muted, #586675); font-size: 11px; }
.elium-upd-list { margin: 0; padding-left: 17px; }
.elium-upd-list li { margin: 3px 0; }
/* Une barre de défilement discrète : la liste peut être longue. */
.elium-upd-notes::-webkit-scrollbar { width: 8px; }
.elium-upd-notes::-webkit-scrollbar-thumb {
  background: var(--el-border-strong, #cbd5e1); border-radius: 999px;
}
.elium-upd-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--el-border, #e2e8f0);
  font-size: 12px; color: var(--el-text-muted, #586675);
}
.elium-upd-sel {
  font: inherit; color: var(--el-text, #0f172a); background: var(--el-surface, #fff);
  border: 1px solid var(--el-border, #e2e8f0); border-radius: var(--el-radius-md, 8px); padding: 2px 6px;
}
.elium-upd-link {
  background: none; border: 0; cursor: pointer; font: inherit; padding: 0;
  color: var(--el-primary, #1d4ed8); text-decoration: underline;
}
.elium-upd-link:disabled { opacity: .6; cursor: default; }
.elium-upd-spin {
  width: 22px; height: 22px; flex: none;
  border: 2.5px solid var(--el-surface-3, #f1f5f9);
  border-top-color: var(--el-primary, #1d4ed8); border-radius: 50%;
  animation: elium-upd-rot .7s linear infinite;
}
@keyframes elium-upd-rot { to { transform: rotate(360deg); } }
@keyframes elium-upd-in {
  from { opacity: 0; transform: translateY(16px) scale(.98); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  #elium-upd.show { animation: none; }
  .elium-upd-bar, .elium-upd-bar.indet { animation: none; transition: none; }
  .elium-upd-spin { animation-duration: 2s; }
}
"""

UPDATE_JS = """
(function () {
  var card, badge, spin, title, sub, track, bar, btn, later, more, notes, foot, chanSel, fileBtn, fileIn, fbMsg;
  var dismissed = false, expanded = false, notesKey = '', fbDismissed = false;
  function build() {
    card = document.createElement('div'); card.id = 'elium-upd';
    var head = document.createElement('div'); head.className = 'elium-upd-head';
    spin = document.createElement('div'); spin.className = 'elium-upd-spin'; spin.style.display = 'none';
    badge = document.createElement('div'); badge.className = 'elium-upd-badge'; badge.textContent = '\\u{1F504}';
    var txt = document.createElement('div'); txt.className = 'elium-upd-txt';
    title = document.createElement('div'); title.className = 'elium-upd-title';
    sub = document.createElement('div'); sub.className = 'elium-upd-sub';
    txt.appendChild(title); txt.appendChild(sub);
    head.appendChild(spin); head.appendChild(badge); head.appendChild(txt);
    track = document.createElement('div'); track.className = 'elium-upd-track'; track.style.display = 'none';
    bar = document.createElement('div'); bar.className = 'elium-upd-bar'; track.appendChild(bar);
    btn = document.createElement('button'); btn.className = 'elium-upd-btn'; btn.style.display = 'none';
    later = document.createElement('button'); later.className = 'elium-upd-later';
    later.textContent = 'Plus tard'; later.style.display = 'none';
    later.onclick = function () { dismissed = true; card.classList.remove('show'); };
    notes = document.createElement('div'); notes.className = 'elium-upd-notes';
    more = document.createElement('button'); more.className = 'elium-upd-more';
    more.onclick = function () { expanded = !expanded; syncNotes(); };
    // Pied de carte : canal de mise à jour (stable/bêta) + mise à jour depuis un fichier
    // hors ligne (.eliumupdate, vérifié par signature comme une mise à jour en ligne).
    foot = document.createElement('div'); foot.className = 'elium-upd-foot'; foot.style.display = 'none';
    var chanWrap = document.createElement('label'); chanWrap.className = 'elium-upd-chan';
    chanWrap.appendChild(document.createTextNode('Canal : '));
    chanSel = document.createElement('select'); chanSel.className = 'elium-upd-sel';
    chanSel.setAttribute('aria-label', 'Canal de mise à jour');
    [['stable', 'Stable'], ['beta', 'Bêta (préversions)']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; chanSel.appendChild(op);
    });
    chanSel.onchange = function () { post('/__update__/channel?name=' + encodeURIComponent(chanSel.value)); };
    chanWrap.appendChild(chanSel);
    fileBtn = document.createElement('button'); fileBtn.className = 'elium-upd-link'; fileBtn.type = 'button';
    fileBtn.textContent = 'Mettre à jour depuis un fichier…';
    fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = '.eliumupdate';
    fileIn.style.display = 'none';
    fileBtn.onclick = function () { fileIn.click(); };
    fileIn.onchange = function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      fileBtn.disabled = true;
      post('/__update__/bundle', f).then(function () { fileBtn.disabled = false; fileIn.value = ''; });
    };
    foot.appendChild(chanWrap); foot.appendChild(fileBtn); foot.appendChild(fileIn);
    card.appendChild(head); card.appendChild(track); card.appendChild(more);
    card.appendChild(notes); card.appendChild(btn); card.appendChild(later); card.appendChild(foot);
    document.body.appendChild(card);
  }
  function post(path, body) {
    // Jeton anti-CSRF relu depuis la balise <meta> injectée dans CE document
    // (jamais un script inline, cf. _serve_index_with_banner côté serveur) —
    // relu à chaque appel plutôt que mis en cache, pour ne dépendre d'aucun
    // ordre d'exécution avec l'injection de la balise.
    var meta = document.querySelector('meta[name="elium-token"]');
    var token = meta ? meta.getAttribute('content') : '';
    var init = { method: 'POST', headers: { 'X-Elium-Token': token } };
    if (body) init.body = body;
    return fetch(path, init)
      .then(function (r) { return r.json(); }).catch(function () {});
  }
  // Après un redémarrage exe : l'ancien process meurt puis le nouveau reprend le
  // même port en general en moins d'une seconde, mais SANS ce sondage la page
  // reste affichee telle quelle (React ne re-fetch jamais /__version__ tout seul)
  // -> l'utilisateur voit un panneau "installee : ancienne version" alors que le
  // nouvel exe tourne deja. On sonde jusqu'a ce qu'il reponde, puis on recharge.
  function waitForServerThenReload() {
    var attempts = 0;
    function tryOnce() {
      attempts += 1;
      fetch('/__version__', { cache: 'no-store' })
        .then(function (r) { if (r.ok) location.reload(); else scheduleRetry(); })
        .catch(scheduleRetry);
    }
    function scheduleRetry() {
      if (attempts < 40) setTimeout(tryOnce, 500);
      else location.reload(); // dernier recours : au moins tenter un rechargement
    }
    setTimeout(tryOnce, 400); // laisse l'ancien serveur liberer le port
  }
  function set(icon, t, s) { badge.textContent = icon; title.textContent = t; sub.textContent = s; }
  function syncNotes() {
    more.classList.toggle('open', expanded);
    notes.classList.toggle('open', expanded);
    more.firstChild.nodeValue = expanded ? 'Masquer les nouveautés ' : 'Voir les nouveautés ';
  }
  // On ne reconstruit la liste que si la charge a REELLEMENT change : la carte
  // interroge le statut toutes les 2 s, et rebatir a chaque tour arracherait le
  // defilement sous le doigt de qui est en train de lire.
  function fillNotes(releases) {
    var key = JSON.stringify(releases || []);
    if (key === notesKey) return;
    notesKey = key;
    notes.replaceChildren();
    var total = 0;
    (releases || []).forEach(function (rel) {
      var items = rel.changes || [];
      if (!items.length) return;
      var h = document.createElement('div'); h.className = 'elium-upd-relv';
      var v = document.createElement('span'); v.textContent = 'Version ' + (rel.version || '');
      h.appendChild(v);
      if (rel.date) {
        var d = document.createElement('span'); d.className = 'elium-upd-reld';
        d.textContent = rel.date; h.appendChild(d);
      }
      notes.appendChild(h);
      var ul = document.createElement('ul'); ul.className = 'elium-upd-list';
      items.forEach(function (c) {
        var li = document.createElement('li'); li.textContent = c; ul.appendChild(li);
      });
      notes.appendChild(ul);
      total += items.length;
    });
    var chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '\\u25BC';
    more.replaceChildren(document.createTextNode('Voir les nouveautés '), chev);
    more.classList.toggle('on', total > 0);
    if (!total) expanded = false;
    syncNotes();
  }
  function render(st) {
    if (!card) { if (!document.body) return; build(); }
    var s = st.state;
    var showBtn = false, showTrack = false, showSpin = false, showLater = false;
    card.classList.remove('ready', 'err');
    // Les nouveautes restent affichees de la detection jusqu'a l'ecran « prete » :
    // c'est la meme mise a jour, l'utilisateur ne doit pas les perdre en route.
    fillNotes(st.releases);
    var showFoot = false;
    // Retour automatique à la version embarquée après des plantages au démarrage : annoncé
    // une fois, tant qu'aucune autre mise à jour n'occupe la carte.
    var busy = (s === 'available' || s === 'downloading' || s === 'web-ready' || s === 'exe-ready');
    if (st.channel) chanSel.value = st.channel;
    if (st.fallback && !fbDismissed && !busy) {
      card.classList.add('err'); badge.style.display = '';
      set('\\u21A9\\uFE0F', 'Retour à la version précédente',
        'La version ' + (st.fallback.version || '') + ' n\\u2019a pas démarré correctement : ' +
        'Elium a rétabli la version ' + (st.fallback.base || 'intégrée') + '.');
      btn.textContent = 'Compris'; btn.disabled = false;
      btn.onclick = function () { fbDismissed = true; card.classList.remove('show'); };
      card.classList.add('show');
      btn.style.display = ''; later.style.display = 'none'; track.style.display = 'none';
      spin.style.display = 'none'; foot.style.display = 'none';
      return;
    }
    if (s === 'available') {
      if (dismissed) { card.classList.remove('show'); return; }
      badge.style.display = '';
      // Le résumé (« 3 versions, 12 nouveautés ») dit d'emblée l'ampleur de ce
      // qui arrive ; à défaut on retombe sur le simple numéro de version.
      set('\\u{1F504}', 'Mise à jour disponible', 'Version ' + (st.version || '') +
        (st.summary ? ' \\u2014 ' + st.summary : ' \\u2014 installez-la en un clic'));
      btn.textContent = 'Mettre à jour'; btn.disabled = false; showBtn = true; showLater = true; showFoot = true;
      btn.onclick = function () { btn.disabled = true; post('/__update__/start'); };
    } else if (s === 'downloading') {
      badge.style.display = 'none'; showSpin = true; showTrack = true;
      var p = st.progress || 0;
      set('', 'Téléchargement de la mise à jour…', p > 0 ? (p + ' %') : 'Préparation…');
      if (p > 0) { bar.classList.remove('indet'); bar.style.width = p + '%'; }
      else { bar.classList.add('indet'); }
    } else if (s === 'web-ready') {
      card.classList.add('ready'); badge.style.display = '';
      set('\\u2705', 'Mise à jour prête !', 'Rechargez pour utiliser la version ' + (st.version || ''));
      btn.textContent = 'Recharger maintenant'; btn.disabled = false; showBtn = true;
      btn.onclick = function () { location.reload(); };
    } else if (s === 'exe-ready') {
      card.classList.add('ready'); badge.style.display = '';
      set('\\u2705', 'Mise à jour prête !', 'Redémarrez Elium pour terminer');
      btn.textContent = 'Redémarrer Elium'; btn.disabled = false; showBtn = true;
      btn.onclick = function () {
        btn.disabled = true; set('\\u2705', 'Redémarrage…', '');
        post('/__update__/restart').then(waitForServerThenReload);
      };
    } else if (s === 'check-failed') {
      // Hors ligne = situation NORMALE d'une application local-first : pas de carte (le pied
      // de page de l'accueil l'indique). Les autres causes (quota, signature…) méritent d'être vues.
      if (st.reason === 'offline' || dismissed) { card.classList.remove('show'); return; }
      card.classList.add('err'); badge.style.display = '';
      set('\\u26A0\\uFE0F', 'Vérification impossible',
        st.message || 'La recherche de mise à jour n\\u2019a pas pu aboutir.');
      btn.textContent = 'Réessayer'; btn.disabled = false; showBtn = true; showLater = true; showFoot = true;
      btn.onclick = function () {
        btn.disabled = true;
        post('/__update__/check').then(function () { btn.disabled = false; });
      };
    } else if (s === 'error') {
      card.classList.add('err'); badge.style.display = '';
      set('\\u26A0\\uFE0F', 'Échec de la mise à jour', st.message || 'Vérifiez votre connexion, puis réessayez');
      btn.textContent = 'Réessayer'; btn.disabled = false; showBtn = true; showLater = true; showFoot = true;
      btn.onclick = function () { btn.disabled = true; post('/__update__/start'); };
    }
    var visible = (s === 'available' || s === 'downloading' || s === 'web-ready' ||
                   s === 'exe-ready' || s === 'error' || (s === 'check-failed' && !dismissed));
    card.classList.toggle('show', visible);
    btn.style.display = showBtn ? '' : 'none';
    later.style.display = showLater ? '' : 'none';
    track.style.display = showTrack ? '' : 'none';
    spin.style.display = showSpin ? '' : 'none';
    foot.style.display = showFoot ? '' : 'none';
  }
  function poll() {
    fetch('/__update__').then(function (r) { return r.json(); }).then(render).catch(function () {});
  }
  setTimeout(poll, 1500);
  setInterval(poll, 2000);
})();
"""


def current_web_dir() -> Path:
    """Dossier web à servir : overlay auto-update s'il est plus récent, sinon embarqué."""
    if updater is not None:
        try:
            overlay = updater.active_web_dir()
            if overlay:
                return Path(overlay)
        except Exception as e:
            _log_launcher(f"current_web_dir: overlay indisponible, repli sur le web embarqué ({e})")
    return get_web_dir()


# Dossier web « épinglé » pour la session en cours : ne change qu'à une navigation
# (chargement d'index.html), pour ne pas mélanger anciens/nouveaux assets Vite.
_serving_dir: "Path | None" = None
_serving_lock = threading.Lock()


def _resolve_serving_dir(refresh: bool) -> Path:
    global _serving_dir
    with _serving_lock:
        if refresh or _serving_dir is None:
            _serving_dir = current_web_dir()
        return _serving_dir


# Redémarrage propre pour appliquer une màj exe : on ferme la fenêtre courante puis
# main() relance le nouvel exe. Ces globals relient le handler HTTP à la boucle main().
_browser_proc: "subprocess.Popen | None" = None
_fallback_event: "threading.Event | None" = None
_restart_requested = False
_port_fallback_used = False


# --------------------------------------------------------------------------- #
# Limite de débit sur les routes d'état — défense en profondeur EN PLUS du
# jeton anti-CSRF : même une origine légitime (donc déjà en possession du
# jeton) ne doit pas pouvoir déclencher un redémarrage/rollback en boucle
# (bug côté front, script compromis après coup, etc.). Fenêtre glissante
# simple : c'est un process mono-utilisateur, pas la peine d'un vrai
# algorithme de seau à jetons distribué.
# --------------------------------------------------------------------------- #
_RATE_LIMIT_WINDOW_S = 10.0
_RATE_LIMIT_MAX_CALLS = 6
_rate_limit_hits: "list[float]" = []
_rate_limit_lock = threading.Lock()


# Corps maximal accepté par POST /__ports__/set ({"port": 3000} tient en une vingtaine d'octets).
_MAX_SET_PORT_BODY = 1024
# Paquet de mise à jour hors ligne déposé via la carte : même borne qu'un artefact (updater).
_MAX_BUNDLE_UPLOAD = 420 * 1024 * 1024

_TSA_MAX_REQUEST = 8 * 1024
_TSA_MAX_REPLY = 64 * 1024


_TSA_TIMEOUT_S = 15


def _tsa_is_non_public(ip_text: str) -> bool:
    """Vrai pour toute adresse que le relais ne doit jamais joindre : non globale
    (privée, loopback, lien local, site local fec0::/10, CGNAT 100.64/10,
    documentation…), multicast, et les IPv4 embarquées (IPv4-mapped, 6to4,
    NAT64 64:ff9b::/96) jugées sur l'IPv4 qu'elles désignent."""
    import ipaddress

    try:
        ip = ipaddress.ip_address(ip_text.split("%", 1)[0])
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return _tsa_is_non_public(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return _tsa_is_non_public(str(ip.sixtofour))
        if ip in ipaddress.ip_network("64:ff9b::/96"):
            return _tsa_is_non_public(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
        if ip in ipaddress.ip_network("::/96") or ip.is_site_local or ip.teredo is not None:
            return True
    return (
        not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip.is_loopback or ip.is_link_local
    )


def _tsa_resolve(url: str) -> "tuple[str | None, tuple | None]":
    """Résout la cible UNE seule fois : (problème, None) ou (None, cible), la cible
    étant (schéma, hôte, port, chemin, ip vérifiée) — la connexion se fait vers
    cette ip, jamais vers une seconde résolution (rebinding DNS)."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:  # port hors bornes / non numérique, IPv6 mal formée
        return "Adresse du serveur d'horodatage invalide", None
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        return "Adresse du serveur d'horodatage invalide", None
    port = port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        return "Serveur d'horodatage introuvable", None
    addresses = [str(info[4][0]) for info in infos]
    if not addresses or any(_tsa_is_non_public(a) for a in addresses):
        return "Adresse réseau non autorisée pour l'horodatage", None
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return None, (parts.scheme, parts.hostname, port, path, addresses[0])


def _tsa_target_problem(url: str) -> "str | None":
    """Refuse ce qui n'est pas un serveur d'horodatage public en http(s)."""
    return _tsa_resolve(url)[0]


def _tsa_send(target: tuple, body: bytes) -> bytes:
    """POST vers l'ip déjà vérifiée de `target` (Host et SNI = nom d'origine), sans
    suivre de redirection, réponse bornée à _TSA_MAX_REPLY."""
    import http.client
    import ssl

    scheme, host, port, path, ip = target
    if _tsa_is_non_public(ip):
        raise ValueError("adresse d'horodatage non publique")
    sock = socket.create_connection((ip, port), timeout=_TSA_TIMEOUT_S)
    conn: http.client.HTTPConnection
    try:
        if scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            conn = http.client.HTTPSConnection(host, port, timeout=_TSA_TIMEOUT_S)
        else:
            conn = http.client.HTTPConnection(host, port, timeout=_TSA_TIMEOUT_S)
    except BaseException:
        sock.close()
        raise
    conn.sock = sock  # déjà connecté : http.client ne résout ni ne se reconnecte
    try:
        conn.request(
            "POST",
            path,
            body=body,
            headers={"Content-Type": "application/timestamp-query", "User-Agent": "Elium"},
        )
        res = conn.getresponse()
        if not 200 <= res.status < 300:  # redirections comprises : jamais suivies
            raise ValueError(f"réponse d'horodatage HTTP {res.status}")
        data = res.read(_TSA_MAX_REPLY + 1)
    finally:
        conn.close()
    if len(data) > _TSA_MAX_REPLY:
        raise ValueError("réponse d'horodatage trop volumineuse")
    return data


def _tsa_forward(url: str, body: bytes) -> bytes:
    problem, target = _tsa_resolve(url)
    if problem or target is None:
        raise ValueError(problem or "cible d'horodatage invalide")
    return _tsa_send(target, body)


def _rate_limited() -> bool:
    import time as _time

    now = _time.monotonic()
    with _rate_limit_lock:
        while _rate_limit_hits and now - _rate_limit_hits[0] > _RATE_LIMIT_WINDOW_S:
            _rate_limit_hits.pop(0)
        if len(_rate_limit_hits) >= _RATE_LIMIT_MAX_CALLS:
            return True
        _rate_limit_hits.append(now)
        return False


def _request_restart() -> bool:
    """Demande le redémarrage vers le lanceur mis à jour (bouton « Redémarrer »)."""
    global _restart_requested
    if updater is None:
        return False
    _restart_requested = True
    if _browser_proc is not None:
        try:
            _browser_proc.terminate()  # débloque proc.wait() dans main()
        except Exception as e:
            _log_launcher(f"request_restart: échec terminate() du processus navigateur ({e})")
    elif _fallback_event is not None:
        _fallback_event.set()
    return True


# --------------------------------------------------------------------------- #
# Instance unique + transmission de fichiers (double-clic sur un .elium pendant
# qu'Elium est déjà ouvert).
#
# Avant : un 2e lancement démarrait un 2e serveur et ouvrait une 2e fenêtre sur
# le MÊME profil Edge ; Edge confiait alors l'URL à la fenêtre existante et le
# nouveau processus se terminait aussitôt — son serveur s'arrêtait avec lui et
# le fichier n'était jamais ouvert. Maintenant : un mutex système garantit UNE
# instance ; un 2e lancement dépose le fichier dans une boîte aux lettres
# (%LOCALAPPDATA%\Elium\inbox), amène la fenêtre existante au premier plan et
# se termine. L'instance en cours consomme la boîte, et la page l'apprend via
# /__open_seq__.
# --------------------------------------------------------------------------- #
_MUTEX_NAME = "Local\\EliumDesktopSingleInstance"
_MAX_OPEN_BYTES = 256 * 1024 * 1024
_mutex_handle = None
_instance_lock_file = None


def _data_dir() -> Path:
    base = Path(os.environ.get("LocalAppData") or Path.home()) / "Elium"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _inbox_dir() -> Path:
    d = _data_dir() / "inbox"
    d.mkdir(parents=True, exist_ok=True)
    return d


def acquire_single_instance() -> bool:
    """True si CE processus est (désormais) l'instance principale.

    En cas de doute (API indisponible), renvoie True : mieux vaut deux instances
    qu'une application qui ne démarre pas."""
    global _mutex_handle, _instance_lock_file
    try:
        if os.name == "nt":
            import ctypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateMutexW.restype = ctypes.c_void_p
            k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
            k32.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = k32.CreateMutexW(None, False, _MUTEX_NAME)
            if not handle:
                return True
            if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                k32.CloseHandle(handle)
                return False
            _mutex_handle = handle
            return True
        import fcntl  # POSIX

        f = open(_data_dir() / "instance.lock", "w")  # noqa: SIM115 — gardé ouvert toute la vie du process
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            f.close()
            return False
        _instance_lock_file = f
        return True
    except Exception as e:
        _log_launcher(f"acquire_single_instance: indisponible ({e})")
        return True


def release_single_instance() -> None:
    """Libère le verrou (avant de relancer l'application pour une mise à jour)."""
    global _mutex_handle, _instance_lock_file
    try:
        if _mutex_handle is not None and os.name == "nt":
            import ctypes

            k32 = ctypes.WinDLL("kernel32")
            k32.CloseHandle.argtypes = [ctypes.c_void_p]
            k32.CloseHandle(_mutex_handle)
        if _instance_lock_file is not None:
            _instance_lock_file.close()
    except Exception as e:
        _log_launcher(f"release_single_instance: {e}")
    _mutex_handle = None
    _instance_lock_file = None


def _focus_existing_window() -> bool:
    """Amène la fenêtre Elium existante au premier plan (Windows). True si trouvée."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32")
        found: list[int] = []
        enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def _cb(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            cls = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls, 64)
            if cls.value != "Chrome_WidgetWin_1":  # Edge/Chrome — pas l'Explorateur
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value.startswith("Elium"):
                found.append(hwnd)
            return True

        user32.EnumWindows(enum_proc(_cb), 0)
        if not found:
            return False
        hwnd = found[0]
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        return True
    except Exception as e:
        _log_launcher(f"_focus_existing_window: {e}")
        return False


def forward_to_running_instance(file_path: "str | None") -> bool:
    """Confie `file_path` (s'il y en a un) à l'instance déjà ouverte et la met au
    premier plan. True si la demande a été prise en charge — le 2e lancement peut
    alors se terminer ; False pour démarrer normalement (instance figée/absente)."""
    if file_path:
        try:
            src = Path(file_path)
            if src.stat().st_size > _MAX_OPEN_BYTES:
                return False
            tmp = _inbox_dir() / f"{uuid.uuid4().hex}__{urllib.parse.quote(src.name)}.tmp"
            tmp.write_bytes(src.read_bytes())
            final = tmp.with_suffix(".open")
            tmp.rename(final)
        except OSError as e:
            _log_launcher(f"forward_to_running_instance: dépôt impossible ({e})")
            return False
        # L'instance principale doit consommer le fichier rapidement ; sinon elle
        # est figée : on retire notre dépôt et on démarre normalement.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not final.exists():
                break
            time.sleep(0.1)
        else:
            final.unlink(missing_ok=True)
            return False
    return _focus_existing_window() or bool(file_path)


def _consume_inbox_once() -> None:
    """Charge dans le serveur chaque fichier déposé par un 2e lancement."""
    for f in sorted(_inbox_dir().glob("*.open")):
        try:
            name = urllib.parse.unquote(f.stem.split("__", 1)[1])
            data = f.read_bytes()
            f.unlink()
        except (OSError, IndexError) as e:
            _log_launcher(f"inbox: fichier ignoré ({e})")
            f.unlink(missing_ok=True)
            continue
        QuietHandler.opened_file = (name, data)
        QuietHandler.open_seq += 1


def start_inbox_watcher() -> None:
    def loop():
        while True:
            try:
                _consume_inbox_once()
            except Exception as e:
                _log_launcher(f"inbox watcher: {e}")
            time.sleep(0.4)

    # Fichiers restés d'une session précédente : jamais rouverts à l'aveugle.
    for stale in _inbox_dir().glob("*"):
        stale.unlink(missing_ok=True)
    threading.Thread(target=loop, daemon=True, name="elium-inbox").start()


_boot_ok_marked = False


def _note_page_served() -> None:
    """Première page réellement servie = le démarrage a abouti : on le signale à la garde
    anti boucle de plantage de l'updater (sans quoi N démarrages ratés d'un exe mis à jour
    le font abandonner au profit de la version embarquée)."""
    global _boot_ok_marked
    if _boot_ok_marked or updater is None:
        return
    _boot_ok_marked = True
    try:
        updater.mark_boot_ok()
    except Exception as e:
        _log_launcher(f"mark_boot_ok: {e}")


def _extract_update_bundle_arg(argv: "list[str]") -> "tuple[list[str], str | None]":
    """Sépare un éventuel paquet `.eliumupdate` des arguments (`Elium.exe fichier.eliumupdate`
    ou `Elium.exe --apply-update fichier`) : il s'applique AVANT le démarrage, il ne doit pas
    être pris pour un document `.elium` à ouvrir. Renvoie (arguments restants, chemin ou None)."""
    rest: list[str] = []
    bundle: str | None = None
    it = iter(argv)
    for a in it:
        if a == "--apply-update":
            nxt = next(it, None)
            if nxt:
                bundle = nxt
        elif a.lower().endswith(".eliumupdate") and os.path.isfile(a):
            bundle = a
        else:
            rest.append(a)
    return rest, bundle


def _is_local_host(host: "str | None", port: int) -> bool:
    """Le Host d'une requête GET sensible doit être celui de CE serveur loopback
    (anti DNS-rebinding : une page tierce dont le nom pointe vers 127.0.0.1 ne
    peut plus lire /__open__)."""
    return (host or "") in (f"127.0.0.1:{port}", f"localhost:{port}")


def find_free_port(start: int = 3000, end: int = 3100) -> int:
    """Trouve un port libre dans la plage donnée."""
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"Aucun port libre trouvé entre {start} et {end}")


def _is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


# --------------------------------------------------------------------------- #
# Port du serveur local : configurable (visible + sélectionnable dans l'appli).
#
# Par défaut, un port libre est choisi automatiquement dans PORT_RANGE (comme
# avant). L'utilisateur peut épingler un port précis (ex. si un pare-feu
# d'entreprise n'autorise qu'un port fixe, ou pour éviter un conflit récurrent
# avec un autre outil local) — persisté dans un petit fichier de config, pris
# en compte au PROCHAIN démarrage (le serveur HTTP déjà lié ne peut pas migrer
# de port à chaud sans interrompre la session en cours).
# --------------------------------------------------------------------------- #
PORT_RANGE = (3000, 3100)


def _config_path() -> Path:
    base = Path(os.environ.get("LocalAppData") or Path.home()) / "Elium"
    base.mkdir(parents=True, exist_ok=True)
    return base / "launcher-config.json"


def _load_launcher_config() -> dict:
    try:
        return json.loads(_config_path().read_text(encoding="utf-8"))
    except Exception as e:
        _log_launcher(f"_load_launcher_config: config illisible/corrompue, repli sur {{}} ({e})")
        return {}


def _save_launcher_config(cfg: dict) -> None:
    try:
        _config_path().write_text(json.dumps(cfg), encoding="utf-8")
    except Exception as e:
        _log_launcher(f"_save_launcher_config: échec d'écriture ({e})")


def _configured_port() -> "int | None":
    port = _load_launcher_config().get("port")
    return port if isinstance(port, int) and 1024 <= port <= 65535 else None


def resolve_port() -> tuple[int, bool]:
    """Port à utiliser pour ce lancement + indicateur « repli utilisé » (le port
    choisi par l'utilisateur était occupé, un autre a été pris à la place)."""
    chosen = _configured_port()
    if chosen is not None:
        if _is_port_free(chosen):
            return chosen, False
        _log_launcher(f"port configuré {chosen} occupé — repli automatique")
        return find_free_port(*PORT_RANGE), True
    return find_free_port(*PORT_RANGE), False


def scan_ports(count: int = 12) -> list[dict]:
    """Renvoie la disponibilité des `count` premiers ports de PORT_RANGE, plus le
    port actuellement configuré s'il est en dehors de cette fenêtre (pour ne
    jamais le faire disparaître silencieusement de l'écran de sélection)."""
    start, end = PORT_RANGE
    ports = list(range(start, min(start + count, end)))
    configured = _configured_port()
    if configured is not None and configured not in ports:
        ports.append(configured)
    return [{"port": p, "free": _is_port_free(p)} for p in sorted(set(ports))]


def _log_launcher(message: str) -> None:
    """Best-effort : réutilise le même fichier/format que le journal de l'updater
    quand disponible, pour n'avoir qu'UN SEUL journal à consulter (support)."""
    if updater is not None:
        try:
            updater._log(message)  # noqa: SLF001 — même processus, même fichier de log
            return
        except Exception:  # noqa: S110 — c'est LE puits de journalisation ; rien d'autre où logguer cet échec.
            pass


def get_web_dir() -> Path:
    """Retourne le chemin du dossier web-studio buildé."""
    # 1) Bundle PyInstaller onefile/onedir : le Web Studio est embarqué sous _MEIPASS/web
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        bundled = Path(meipass) / "web"
        if bundled.exists():
            return bundled

    # 2) Installé : le dossier web est à côté de l'exécutable
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).parent
    else:
        base = Path(__file__).resolve().parent.parent

    web_dir = base / "web"
    if not web_dir.exists():
        # 3) Dév : web-studio/dist
        web_dir = base / "web-studio" / "dist"
    if not web_dir.exists():
        print(f"ERREUR: Dossier web introuvable: {web_dir}")
        sys.exit(1)
    return web_dir


def find_app_browser() -> "str | None":
    """Cherche un navigateur Chromium capable du mode --app (fenêtre dédiée)."""
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    local = os.environ.get("LocalAppData", "")
    candidates = [
        Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
        Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe" if local else None,
    ]
    for c in candidates:
        if c and c.is_file():
            return str(c)
    return None


def app_profile_dir() -> Path:
    """Profil navigateur dédié à Elium : n'altère pas le navigateur personnel."""
    base = Path(os.environ.get("LocalAppData") or Path.home()) / "Elium" / "WebProfile"
    base.mkdir(parents=True, exist_ok=True)
    return base


# Politique de sécurité du contenu servie avec CHAQUE réponse. Principe : tout
# vient de l'origine locale ('self') ; les seules exceptions sont des schémas
# de données produits par l'application elle-même (data:, blob:), jamais une
# origine réseau, et le script reste strict (ni 'unsafe-inline' ni
# 'unsafe-eval' : aucune exécution de chaîne, aucun <script> inline).
CSP_DIRECTIVES: "tuple[str, ...]" = (
    "default-src 'self'",
    # 'wasm-unsafe-eval' autorise WebAssembly (Argon2id via hash-wasm, utilisé
    # par TOUT le chiffrement/identité ; décodeurs JPEG 2000 / JBIG2 / couleurs
    # ICC de pdf.js) SANS ouvrir l'eval() de chaînes. Sans lui, une WebView
    # Chromium récente bloque WebAssembly.compile() sous default-src 'self'.
    "script-src 'self' 'wasm-unsafe-eval'",
    # Polices embarquées dans l'application (web-studio/public/fonts) : aucune
    # origine réseau, l'appli reste 100 % hors ligne.
    "style-src 'self'",
    "font-src 'self'",
    # data: → images de signature / tampons / pages-images insérées gardées en
    # data: URL dans le document (aperçus des dialogues <img src="data:…">) ;
    # blob: → aperçus d'images choisies par l'utilisateur (createObjectURL).
    "img-src 'self' data: blob:",
    # blob: → workers créés à partir d'un Blob (moteur OCR Tesseract) ; le
    # worker pdf.js, lui, est servi depuis 'self'.
    "worker-src 'self' blob:",
    # data:/blob: → lecture par fetch()/XHR de données déjà en mémoire (image
    # de signature en data: URL, fichier déposé mis en blob:, modèles OCR
    # chargés par le worker Tesseract). Aucune origine réseau n'est ajoutée :
    # pas de fuite possible vers l'extérieur.
    "connect-src 'self' data: blob:",
    # data:/blob: → médias produits localement (pièce jointe audio/vidéo d'un
    # PDF lue sans l'écrire sur disque). Là encore, aucune origine réseau.
    "media-src 'self' data: blob:",
    # blob: → impression : le PDF construit est chargé dans une <iframe> blob:
    # invisible puis imprimé (PdfWorkspace « Imprimer »).
    "frame-src 'self' blob:",
    # Aucun plugin (<object>/<embed>) ; <base> ne peut pas détourner les URL
    # relatives vers une autre origine.
    "object-src 'none'",
    "base-uri 'self'",
)
CONTENT_SECURITY_POLICY = "; ".join(CSP_DIRECTIVES)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serveur HTTP silencieux pour le Web Studio (+ fichier ouvert via Explorer)."""

    # (nom de fichier, contenu) du .elium passé en argument, servi sur /__open__.
    opened_file: "tuple[str, bytes] | None" = None
    # Incrémenté à chaque fichier reçu d'un 2e lancement ; la page l'interroge.
    open_seq: int = 0

    # Types fixés ici, pas laissés à `mimetypes` : sous Windows il lit le
    # registre, où un logiciel tiers peut avoir déclaré « .js » en text/plain.
    # Avec « nosniff », le navigateur refuserait alors tous les scripts et
    # modules (application, worker pdf.js, bac à sable des formulaires).
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format, *args):
        """Supprime les logs HTTP pour un fonctionnement silencieux."""
        pass

    def send_error(self, code, message=None, explain=None):
        """Le message de statut HTTP voyage en latin-1 : un tiret cadratin ou tout autre
        caractère hors latin-1 ferait lever UnicodeEncodeError (réponse 429 « Trop de
        requêtes — … » jamais envoyée). On assainit donc le message ; le corps HTML, lui,
        reste en UTF-8."""
        if message:
            message = message.encode("latin-1", "replace").decode("latin-1")
        super().send_error(code, message, explain)

    def end_headers(self):
        # Headers de sécurité
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        # Détail et justification de chaque directive : CSP_DIRECTIVES ci-dessus.
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        clean = self.path.split("?", 1)[0]
        # Anti DNS-rebinding sur TOUTES les routes internes /__* (état de mise à jour,
        # versions, ports, fichier ouvert…) : une page tierce dont le nom pointe vers
        # 127.0.0.1 enverrait un Host étranger et ne doit rien pouvoir lire.
        if clean.startswith("/__") and not _is_local_host(
            self.headers.get("Host"), self.server.server_address[1]
        ):
            self.send_error(403, "Hôte non autorisé")
            return
        if clean in ("/__open__", "/__open_seq__"):
            if clean == "/__open_seq__":
                self._serve_bytes(
                    json.dumps({"seq": QuietHandler.open_seq}).encode("utf-8"),
                    "application/json; charset=utf-8",
                )
            else:
                self._serve_opened_file()
            return
        if clean == "/__update__":
            self._serve_update_status()
            return
        if clean == "/__elium_update.js":
            self._serve_bytes(UPDATE_JS.encode("utf-8"), "application/javascript; charset=utf-8")
            return
        if clean == "/__elium_update.css":
            self._serve_bytes(UPDATE_CSS.encode("utf-8"), "text/css; charset=utf-8")
            return
        if clean == "/__version__":
            info = {"installed": None, "base": None, "latest": None, "upToDate": True}
            if updater is not None:
                try:
                    info = updater.version_info()
                except Exception as e:
                    _log_launcher(f"GET /__version__: version_info() a échoué ({e})")
            self._serve_bytes(json.dumps(info).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__releases__":
            releases = []
            if updater is not None:
                try:
                    releases = updater.list_releases()
                except Exception as e:
                    _log_launcher(f"GET /__releases__: list_releases() a échoué ({e})")
            self._serve_bytes(json.dumps({"releases": releases}).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__ports__":
            port = self.server.server_address[1]
            info = {
                "current": port,
                "configured": _configured_port(),
                "fallbackUsed": _port_fallback_used,
                "ports": scan_ports(),
            }
            self._serve_bytes(json.dumps(info).encode("utf-8"), "application/json; charset=utf-8")
            return

        # Résout le dossier web à servir. Sur une navigation (index / route SPA), on
        # (re)fixe le dossier courant — un simple reload applique ainsi une màj web
        # sans mélanger d'anciens et de nouveaux assets (fichiers hashés par Vite).
        is_navigation = clean in ("/", "/index.html") or not os.path.splitext(clean)[1]
        self.directory = str(_resolve_serving_dir(refresh=is_navigation))

        # (Re)chargement de page -> ré-évalue l'état de màj (évite la carte « Recharger »
        # qui revient en boucle une fois la màj web appliquée).
        if is_navigation and updater is not None:
            try:
                updater.on_navigation()
            except Exception as e:
                _log_launcher(f"on_navigation() a échoué ({e})")

        # SPA fallback : sert index.html pour les routes non-fichier.
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.splitext(clean)[1]:
            self.path = "/index.html"
            path = self.translate_path(self.path)

        # Requête « / » : le chemin résolu est le dossier -> on vise son index.html.
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")

        # index.html : on injecte la carte de mise à jour (CSS + script externes, CSP-safe).
        if os.path.basename(path) == "index.html" and os.path.isfile(path):
            self._serve_index_with_banner(path)
            return
        super().do_GET()

    def do_POST(self):
        port = self.server.server_address[1]
        if not _is_authorized_state_request(
            self.headers.get("X-Elium-Token"),
            self.headers.get("Origin"),
            self.headers.get("Host"),
            port,
        ):
            self.send_error(403, "Requête non autorisée (jeton de session ou origine invalide)")
            return
        if _rate_limited():
            self.send_error(429, "Trop de requêtes — patientez quelques secondes")
            return
        clean = self.path.split("?", 1)[0]
        if clean == "/__ports__/set":
            self._handle_set_port()
            return
        if clean == "/__tsa__":
            self._handle_tsa_relay()
            return
        if clean == "/__update__/start":
            status = {"state": "idle"}
            if updater is not None:
                try:
                    status = updater.start_update()
                except Exception as e:
                    _log_launcher(f"POST /__update__/start: start_update() a échoué ({e})")
            self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__update__/check":
            # Vérification manuelle (« Vérifier maintenant ») : synchrone et courte — un
            # échec réseau est borné par les délais de l'updater, le cache ETag/backoff
            # protège le quota GitHub.
            status = {"state": "idle"}
            if updater is not None:
                try:
                    status = updater.check_only()
                except Exception as e:
                    _log_launcher(f"POST /__update__/check: check_only() a échoué ({e})")
            self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__update__/channel":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            name = (qs.get("name", [""])[0] or "").strip().lower()
            status = {"state": "idle"}
            if updater is not None:
                try:
                    status = updater.set_channel(name)
                except Exception as e:
                    _log_launcher(f"POST /__update__/channel: set_channel({name!r}) a échoué ({e})")
            self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__update__/bundle":
            self._handle_bundle_upload()
            return
        if clean == "/__update__/restart":
            ok = _request_restart()
            self._serve_bytes(json.dumps({"ok": ok}).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__rollback__/undo":
            status = {"state": "idle"}
            if updater is not None:
                try:
                    status = updater.undo_last_update()
                except Exception as e:
                    _log_launcher(f"POST /__rollback__/undo: undo_last_update() a échoué ({e})")
            self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
            return
        if clean == "/__rollback__":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            version = (qs.get("version", [""])[0] or "").strip()
            status = {"state": "error"}
            if updater is not None and version:
                try:
                    status = updater.start_rollback(version)
                except Exception as e:
                    _log_launcher(f"POST /__rollback__: start_rollback({version!r}) a échoué ({e})")
            self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
            return
        self.send_error(404, "Endpoint inconnu")

    def _serve_index_with_banner(self, path: str) -> None:
        try:
            html = Path(path).read_bytes()
        except OSError:
            self.send_error(404, "index.html introuvable")
            return
        _note_page_served()
        tag = (
            _token_meta_tag()
            + b'<link rel="stylesheet" href="/__elium_update.css">'
            b'<script src="/__elium_update.js" defer></script>'
        )
        if b"</body>" in html:
            html = html.replace(b"</body>", tag + b"</body>", 1)
        else:
            html = html + tag
        self._serve_bytes(html, "text/html; charset=utf-8")

    def _serve_bytes(self, data: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _handle_tsa_relay(self) -> None:
        """Relaie une demande d'horodatage RFC 3161 vers le serveur choisi par
        l'utilisateur (la CSP interdit à la page tout accès réseau externe)."""
        target = (self.headers.get("X-Elium-TSA-Url") or "").strip()
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        problem, resolved = _tsa_resolve(target)
        if problem or resolved is None or not (0 < length <= _TSA_MAX_REQUEST):
            self.send_error(400, problem or "Demande d'horodatage invalide")
            return
        # Un Content-Length plus grand que le corps réel ne doit pas bloquer ce thread.
        previous_timeout = self.connection.gettimeout()
        self.connection.settimeout(_TSA_TIMEOUT_S)
        try:
            body = self.rfile.read(length)
        except OSError:  # socket.timeout inclus
            body = b""
        finally:
            self.connection.settimeout(previous_timeout)
        if len(body) != length:
            self.close_connection = True
            self.send_error(400, "Demande d'horodatage invalide")
            return
        try:
            reply = _tsa_send(resolved, body)
        except Exception as e:  # réseau, HTTP, taille
            _log_launcher(f"POST /__tsa__: {e}")
            self.send_error(502, "Serveur d'horodatage injoignable")
            return
        self._serve_bytes(reply, "application/timestamp-reply")

    def _handle_bundle_upload(self) -> None:
        """Reçoit un paquet `.eliumupdate` choisi par l'utilisateur (carte « Mettre à jour depuis
        un fichier »), le dépose dans le dossier de travail de l'updater puis lance sa
        vérification/installation EN TÂCHE DE FOND — la signature est contrôlée par l'updater
        exactement comme pour une mise à jour en ligne ; ce relais ne fait confiance à rien."""
        if updater is None:
            self.send_error(503, "Mise à jour indisponible")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if not (0 < length <= _MAX_BUNDLE_UPLOAD):
            self.close_connection = True
            self.send_error(413 if length > 0 else 400, "Paquet de mise à jour invalide ou trop volumineux")
            return
        tmp_dir = updater.data_dir() / "tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        dest = tmp_dir / f"incoming-{uuid.uuid4().hex}{updater.BUNDLE_EXTENSION}"
        remaining = length
        previous_timeout = self.connection.gettimeout()
        self.connection.settimeout(60)
        try:
            with open(dest, "wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
        except OSError as e:
            _log_launcher(f"POST /__update__/bundle: réception interrompue ({e})")
            remaining = -1
        finally:
            self.connection.settimeout(previous_timeout)
        if remaining != 0:
            dest.unlink(missing_ok=True)
            self.close_connection = True
            self.send_error(400, "Paquet incomplet")
            return
        try:
            status = updater.start_bundle_update(dest)
        except Exception as e:
            _log_launcher(f"POST /__update__/bundle: start_bundle_update() a échoué ({e})")
            dest.unlink(missing_ok=True)
            status = {"state": "error"}
        self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")

    def _handle_set_port(self) -> None:
        """Épingle un port pour les PROCHAINS lancements (le serveur déjà lié sur
        CE process ne peut pas migrer à chaud sans couper la session en cours)."""
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length > _MAX_SET_PORT_BODY:  # un corps de quelques octets suffit : on ne lit pas plus
                self.close_connection = True
                self.send_error(413, "Corps de requête trop volumineux")
                return
            body = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(body or b"{}")
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        raw_port = payload.get("port")
        # `None`/absent = « revenir à l'automatique » (efface la préférence).
        if raw_port is None:
            cfg = _load_launcher_config()
            cfg.pop("port", None)
            _save_launcher_config(cfg)
            self._serve_bytes(json.dumps({"ok": True, "port": None}).encode("utf-8"),
                              "application/json; charset=utf-8")
            return
        try:
            wanted = int(raw_port)
        except (TypeError, ValueError):
            self.send_error(400, "Port invalide")
            return
        if not (1024 <= wanted <= 65535):
            self.send_error(400, "Le port doit être compris entre 1024 et 65535")
            return
        if not _is_port_free(wanted):
            self._serve_bytes(
                json.dumps({"ok": False, "error": "port-busy"}).encode("utf-8"),
                "application/json; charset=utf-8",
            )
            return
        cfg = _load_launcher_config()
        cfg["port"] = wanted
        _save_launcher_config(cfg)
        _log_launcher(f"port préféré enregistré : {wanted} (effectif au prochain démarrage)")
        self._serve_bytes(json.dumps({"ok": True, "port": wanted}).encode("utf-8"),
                          "application/json; charset=utf-8")

    def _serve_update_status(self) -> None:
        status = {"state": "idle", "version": None}
        if updater is not None:
            try:
                status = updater.get_status()
            except Exception as e:
                _log_launcher(f"_serve_update_status: get_status() a échoué ({e})")
        self._serve_bytes(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")

    def _serve_opened_file(self):
        item = QuietHandler.opened_file
        if not item:
            self.send_error(404, "Aucun fichier en attente")
            return
        name, data = item
        self.send_response(200)
        self.send_header("Content-Type", "application/x-elium")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Elium-Name", urllib.parse.quote(name))
        self.end_headers()
        self.wfile.write(data)


def main():
    # En mode fenêtré (PyInstaller --noconsole), stdout/stderr valent None.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    # Mise à jour depuis un fichier (Explorateur : double-clic sur un .eliumupdate, ou
    # `Elium.exe --apply-update fichier`) : appliquée AVANT le handoff, pour qu'un exe
    # complet qu'elle dépose soit remis en main dès ce lancement.
    sys.argv[1:], bundle_path = _extract_update_bundle_arg(sys.argv[1:])
    if bundle_path and updater is not None:
        try:
            result = updater.apply_update_bundle(Path(bundle_path))
            _log_launcher(f"main: paquet {Path(bundle_path).name} -> {result.get('state')}")
        except Exception as e:
            _log_launcher(f"main: application du paquet hors ligne en échec ({e})")

    # Handoff : si un lanceur plus récent a été téléchargé, on le relance et on quitte.
    if updater is not None:
        try:
            updater.run_pending_handoff()
        except SystemExit:
            raise
        except Exception as e:
            _log_launcher(f"main: run_pending_handoff() a échoué ({e})")
        try:
            updater.startup_checks()  # verdicts d'intégrité neufs + annonce d'un repli éventuel
        except Exception as e:
            _log_launcher(f"main: startup_checks() a échoué ({e})")

    # ELIUM_NO_BROWSER=1 : mode serveur seul (tests, CI, usage avancé).
    headless = os.environ.get("ELIUM_NO_BROWSER") == "1"

    # Instance unique : un 2e lancement (ex. double-clic sur un .elium) confie son
    # fichier à la fenêtre déjà ouverte au lieu de démarrer un 2e serveur.
    if not headless and not acquire_single_instance():
        arg = sys.argv[1] if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]) else None
        if forward_to_running_instance(arg):
            return

    web_dir = current_web_dir()
    global _port_fallback_used
    port, _port_fallback_used = resolve_port()
    url = f"http://127.0.0.1:{port}/"

    # Fichier .elium passé en argument (double-clic dans l'Explorateur).
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        opened = Path(sys.argv[1])
        QuietHandler.opened_file = (opened.name, opened.read_bytes())
        url += "?open=1"

    handler = partial(QuietHandler, directory=str(web_dir))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"Elium Web Studio démarré sur {url}")

    # Vérifie et applique une mise à jour en arrière-plan (jamais bloquant).
    if updater is not None:
        try:
            updater.start_background_check()
            updater.start_periodic_check()
        except Exception as e:
            _log_launcher(f"main: démarrage des vérifications de mise à jour en échec ({e})")

    if not headless:
        start_inbox_watcher()

    global _browser_proc, _fallback_event

    browser = None if headless else find_app_browser()
    if browser:
        # Fenêtre application dédiée ; le profil séparé garantit un processus
        # propre dont la fin signale la fermeture de la fenêtre.
        # S603 : le chemin vient d'une liste fixe de navigateurs connus.
        _browser_proc = subprocess.Popen([  # noqa: S603
            browser,
            f"--app={url}",
            f"--user-data-dir={app_profile_dir()}",
            "--no-first-run",
            "--no-default-browser-check",
        ])
        try:
            _browser_proc.wait()
        except KeyboardInterrupt:
            _browser_proc.terminate()
        server.shutdown()
        _maybe_relaunch()
        return

    # Repli : onglet du navigateur par défaut ; l'utilisateur arrête avec Ctrl+C.
    print("Appuyez sur Ctrl+C pour arrêter.\n")
    if not headless:
        webbrowser.open(url)
    _fallback_event = threading.Event()
    try:
        _fallback_event.wait()
    except KeyboardInterrupt:
        print("\nArrêt du serveur Elium...")
    server.shutdown()
    _maybe_relaunch()


def _maybe_relaunch() -> None:
    """Après fermeture de la fenêtre : si un redémarrage a été demandé, relance
    soit le nouvel exe en attente (màj), soit — s'il n'y en a pas (ex. juste un
    changement de port) — l'exe COURANT, pour que « Redémarrer » fonctionne dans
    les deux cas avec un seul et même bouton côté interface."""
    release_single_instance()  # sinon le nouveau processus se croirait un 2e lancement
    if not _restart_requested:
        return
    relaunched = False
    if updater is not None:
        try:
            relaunched = updater.relaunch_pending_exe()
        except Exception:
            relaunched = False
    if not relaunched and getattr(sys, "frozen", False):
        try:
            _log_launcher(f"relaunch: redémarrage simple de {Path(sys.executable).name}")
            subprocess.Popen([sys.executable, *sys.argv[1:]])  # noqa: S603
        except Exception as e:
            _log_launcher(f"relaunch: échec du redémarrage simple ({e})")


if __name__ == "__main__":
    main()
