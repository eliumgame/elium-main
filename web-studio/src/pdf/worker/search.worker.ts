/// <reference lib="webworker" />
/** Worker de recherche : la regex saisie par l'utilisateur tourne ici, terminable si le motif est catastrophique. */
import { serveWorkerTask } from "../../workers/worker-host";
import { search, type SearchHit } from "../core/search";
import type { SearchRequest } from "./search-client";

serveWorkerTask<SearchRequest, SearchHit[]>((req) => search(req.pageTexts, req.query, req.opts));
