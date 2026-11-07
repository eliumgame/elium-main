# Passerelle IA Elium (`ai-gateway`)

Une **API compatible OpenAI** placée devant des modèles open source hébergés en Europe. Elle sert à
la fois Elium et tes autres projets. Chaque projet reçoit sa propre clé, qui donne accès à des
**assistants** (une consigne + un modèle + des modèles de secours). La passerelle applique un débit
et un quota mensuel, et ne journalise **jamais** le contenu des messages.

```
Elium (serveur Drive) ─┐
Autre projet ──────────┼─► ai-gateway (VPS) ─► Scaleway (Mistral Medium 3.5, Qwen 3.8…)
Script / n8n ──────────┘                     └► Mistral (secours) · OVHcloud · Ollama local
```

> Les clés `eai_…` sont des secrets **serveur**. Elles ne doivent jamais être placées dans du code
> exécuté par le navigateur. Pour Elium, c'est le serveur Drive qui appelle la passerelle au nom de
> l'utilisateur connecté.

## Modèles retenus (novembre 2026, catalogue Scaleway Serverless)

| Usage | Modèle | Pourquoi |
|---|---|---|
| Rédaction, résumé, qualité | `mistral-medium-3.5-128b` | Meilleur en français du catalogue, éditeur français, poids ouverts (MIT modifiée), 180k de contexte, lit les images |
| Tâches courtes, formules, classement | `qwen3.8-27b` | Modèle compact récent (août 2026), Apache 2.0, rapide et économique, gère le français |
| Secours | Mistral API `mistral-medium-latest` / `mistral-small-latest` | Autre fournisseur, mêmes modèles Mistral |

Écartés : `gpt-oss-120b` (Scaleway le documente pour l'anglais seulement), `mistral-small-3.2` (de
juin 2025, dépassé par Qwen 3.8), `glm-5.2` (fin de vie le 16/11/2026).
`reasoningEffort: "none"` désactive la phase de réflexion des modèles : les réponses sont plus
rapides et moins chères, ce qui suffit pour reformuler ou résumer.

## API

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/health` | Sonde, sans authentification |
| GET | `/v1/models` | Assistants autorisés pour la clé |
| POST | `/v1/chat/completions` | Conversation, en réponse complète ou en flux SSE (`stream: true`) |
| GET | `/v1/usage` | Consommation du mois et limites de la clé |

Le champ `model` contient **l'identifiant d'un assistant** (`elium-redaction`…), jamais le nom d'un
modèle. Les en-têtes `x-gateway-provider` et `x-gateway-model` indiquent quel modèle a répondu.

```bash
curl https://ai.example.fr/v1/chat/completions \
  -H "Authorization: Bearer eai_…" -H "content-type: application/json" \
  -d '{"model":"elium-redaction","messages":[{"role":"user","content":"Rends ce texte plus formel : salut, ça roule ?"}]}'
```

Avec un SDK OpenAI : `new OpenAI({ baseURL: "https://ai.example.fr/v1", apiKey: "eai_…" })`.

**Bascule entre fournisseurs :** si le fournisseur d'une étape tombe en panne, dépasse son délai,
répond 401/403/404/429 ou 5xx, l'étape suivante de la route prend le relais. Une réponse 400
(contexte trop long, paramètre invalide…) est renvoyée telle quelle au client. Un flux déjà commencé
n'est jamais basculé. Si le client se déconnecte, l'appel au fournisseur est coupé pour ne pas
consommer de tokens inutilement.

**Filtrage :** seuls `messages`, `temperature`, `top_p`, `max_tokens`, `stop`, `response_format` et
`stream` sont transmis au fournisseur. Les autres champs (`n`, `tools`…) sont écartés, et
`max_tokens` est plafonné par l'assistant.

## Configuration

Toute la configuration tient dans le fichier `config/gateway.json` (non versionné), créé à partir de
[`config/gateway.example.json`](config/gateway.example.json) :

- `providers` : URL de base compatible OpenAI et **nom** de la variable qui porte la clé (`apiKeyEnv`).
- `assistants` : consigne système, `route` (étapes essayées dans l'ordre), `temperature`, `maxTokens`.
  Les champs `priceInPerMTok` et `priceOutPerMTok` (en € par million de tokens), facultatifs, servent
  à estimer la dépense dans `/v1/usage`.
- `clients` : un par projet. Chaque client contient l'empreinte de sa clé, ses assistants autorisés
  (`"*"` = tous), `requestsPerMinute` et `monthlyTokenQuota` (0 = illimité).

Créer la clé d'un projet :

```bash
npm run key:new -- mon-projet
```

La commande affiche la clé **une seule fois** ainsi que le bloc JSON à coller dans `clients`.

Vérifier les fournisseurs (clé valide, modèles des routes bien présents) :

```bash
npm run providers:check
```

## Développement

```bash
npm ci
npm test
npm run dev
```

`npm test` lance 15 tests contre de faux fournisseurs. `npm run dev` démarre la passerelle sur le
port 8790 ; il faut créer `config/gateway.json` avant.

## Déploiement sur le VPS

Le VPS (2 vCPU, 3,8 Go de RAM, sans GPU) **n'héberge pas de modèle**. Il ne fait tourner que la
passerelle, qui consomme environ 60 Mo, plafonnés à 256 Mo et 0,5 vCPU.

1. Créer un compte Scaleway, puis une clé d'API (IAM → Clés d'API) ; la mettre dans `.env`.
2. `cp config/gateway.example.json config/gateway.json`, puis générer une clé par projet
   (`npm run key:new`) et coller les empreintes.
3. `docker compose up -d --build`, puis `npm run providers:check` (ou `curl 127.0.0.1:8790/health`).
4. Pour exposer la passerelle publiquement (pour les autres projets), ajouter un bloc à Caddy :

   ```
   ai.example.fr {
   	request_body { max_size 8MB }
   	reverse_proxy 127.0.0.1:8790
   }
   ```

   Le serveur Drive d'Elium, lui, l'atteint directement par le réseau Docker
   (`http://ai-gateway:8790`), sans passer par Internet.

## Limites du prototype

- Pas encore branché dans l'interface d'Elium. Il faudra une route côté serveur Drive, une
  activation explicite par organisation (le texte part **en clair** vers le fournisseur, ce qui
  s'écarte du chiffrement de bout en bout) et la parité avec la suite locale.
- Pas d'outils (function calling) ni de RAG pour l'instant.
- Débit en mémoire (une seule instance) ; consommation mensuelle persistée dans `data/usage.json`.
- Prix des modèles non renseignés : les reporter depuis la console Scaleway pour que `costEur` soit
  significatif.
