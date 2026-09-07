Audit LocalLeaf Community — 6 septembrie 2026

**Integrarea pentru release — 7 septembrie 2026:** modificările au fost reaplicate peste `origin/main` (`c5f41b9`, versiunea 0.2.3), păstrând istoricul contributorilor și corecțiile deja publicate. Au fost reunite testele ambelor ramuri, păstrate editările reversibile pentru documentele deschise și limitată memoria pentru copiile remote cu versiune. Instalarea curată aplică toate cele trei patch-uri ale dependențelor.

**Actualizare după remediere:** toate cele șapte constatări de mai jos au fost tratate în cod. Reproducerile au devenit teste de regresie în `src/test/syncAuditTest.ts`, incluse în `npm test`. Descrierile și numerele de linie din auditul inițial sunt păstrate ca istoric.

| Constatare | Comportament după remediere |
| --- | --- |
| F1 | Conținutul remote este asociat versiunii sale; evenimentele duplicate sunt ignorate, iar golurile de versiune determină recitirea documentului. |
| F2 | Uploadul automat compară copia remote cu baza comună și solicită rezolvarea conflictului; schimbările apărute în timpul notificării sunt păstrate. |
| F3 | Ștergerea inspectează descendenții, păstrează fișierele locale/ignorate și bufferele nesalvate și cere o alegere pentru copiile modificate; ștergerile individuale folosesc Trash sau editări VS Code reversibile. |
| F4 | Citirea documentelor prin Pull păstrează abonamentele Socket.IO active. |
| F5 | Pull actualizează arborele; serverele fără metadata HTTP pot folosi arborele unei conexiuni Socket.IO active. |
| F6 | Cache-ul avansează după un upload reușit; conținutul unei tentative eșuate poate fi trimis din nou. |
| F7 | Datele binare sunt normalizate la Buffer înainte de construirea streamului multipart. |

Confirmarea uploadului a fost verificată și față de [implementarea oficială Overleaf](https://github.com/overleaf/overleaf/blob/main/services/real-time/app/js/WebsocketController.js): răspunsul RPC confirmă introducerea operației în coadă. Extensia așteaptă acum și evenimentul de aplicare, apoi recitește documentul pentru a include eventualele transformări produse de editările simultane.

Testele suplimentare acoperă ordinea și duplicarea evenimentelor, conflicte acceptate/refuzate, editări făcute în timpul notificărilor, ștergeri selective, abonamente după pulluri repetate, recuperare după upload eșuat, confirmare/anulare Socket.IO și upload multipart real pe loopback. Testarea completă în interfața VS Code cu un proiect Overleaf real rămâne neexecutată.

Validarea finală după remediere: `npm.cmd test` (TypeScript, bundle, lint și ambele suite), `npm.cmd run package` și încărcarea bundle-ului de producție cu verificarea exporturilor `activate`/`deactivate` au trecut. Testele includ confirmarea Overleaf redusă la `{ doc, v }` și păstrarea conflictului după „Skip”, inclusiv la o salvare locală ulterioară.

Am identificat **7 probleme reproductibile: 5 cu prioritate P1 și 2 cu prioritate P2**. P1 înseamnă risc de alterare/pierdere a datelor sau defect major în sincronizare; P2 înseamnă funcționare incompletă ori recuperare defectuoasă după o eroare. Aceste priorități nu sunt scoruri de vulnerabilitate de securitate.

Am verificat versiunea 0.2.4 din directorul de lucru, inclusiv modificările locale existente peste commit-ul `00cede8`. Auditul a urmărit sincronizarea, ciclul conexiunii, API-ul HTTP/Socket.IO, autentificarea prin browser, validarea căilor și mesajele webview. Nu am modificat implementarea extensiei. Am adăugat acest raport și un script de reproducere.

| ID | Prioritate | Problemă | Referință în cod |
| --- | --- | --- | --- |
| F1 | P1 | O modificare primită în timpul unui pull poate fi aplicată de două ori | `src/sync/syncEngine.ts:1669` |
| F2 | P1 | Salvarea locală poate suprascrie editările recente ale unui colaborator | `src/sync/syncEngine.ts:864–880` |
| F3 | P1 | Ștergerea unui folder remote elimină și date existente doar local | `src/sync/syncEngine.ts:1532–1537` |
| F4 | P1 | Pull/Sync Now întrerupe abonamentele pentru actualizări de documente | `src/sync/syncEngine.ts:2334–2338` |
| F7 | P1 | Încărcarea unui Uint8Array produce o excepție în fluxul multipart | `src/api/base.ts:1049` |
| F5 | P2 | Pull în modul HTTP folosește o listă învechită de fișiere | `src/sync/syncEngine.ts:2270,2445` |
| F6 | P2 | Un upload eșuat este memorat ca ecou și nu se reîncearcă la următorul eveniment identic | `src/sync/syncEngine.ts:545–556` |

**F1 — Verificarea versiunii lipsește la aplicarea operațiilor de text.**

Un colaborator modifică documentul în timp ce `pullAll()` deține blocarea întregului workspace. Evenimentul Socket.IO așteaptă în coadă, dar răspunsul `joinDoc()` poate include deja modificarea. După pull, `handleRemoteFileChanged()` aplică aceeași operație peste conținutul nou, fără să compare `update.v` cu versiunea bazei. În reproducere, serverul conține `Ax`, iar fișierul local ajunge `Axx`. Verificarea poziției și a textului șters nu detectează un insert duplicat valid. Remedierea trebuie să păstreze versiunea asociată fiecărui document, să elimine operațiile deja incluse și să recupereze starea când există un gol între versiuni. Schimbarea bazei și procesarea cozii trebuie coordonate.

**F2 — Uploadul automat înlocuiește starea remote fără verificarea unui conflict.**

Dacă baza comună este `A`, fișierul local devine `A-local`, iar serverul este deja `A-remote`, o salvare locală apelează `pushDocumentChanges()`. Funcția citește ultima versiune remote și calculează direct operațiile care o transformă în copia locală. Nu verifică dacă serverul s-a schimbat față de `baseContent`. Reproducerea confirmă înlocuirea lui `A-remote` cu `A-local` fără întrebare. Situația este posibilă dacă notificarea remote întârzie sau așteaptă blocarea fișierului. Este necesară compararea celor trei stări — baza comună, local și remote — înainte de uploadul automat; un conflict trebuie îmbinat corect sau prezentat utilizatorului. Alegerea explicită „Local” poate păstra semantica de suprascriere.

**F3 — Ștergerile remote ocolesc protecția conflictelor și a fișierelor locale.**

`handleRemoteFileRemoved()` execută `workspace.fs.delete(..., { recursive: true })` pe folderul local. Verifică excluderea folderului, dar nu inspectează modificările și excluderile descendenților. Reproducerea elimină un document cu editări nesincronizate, un fișier care nu a existat niciodată în Overleaf și un fișier ignorat. Nu apare nicio confirmare. Pentru fișiere trebuie comparat conținutul local cu baza; pentru directoare trebuie păstrate elementele locale/ignorate și gestionate conflictele înainte de orice ștergere recursivă. Ramurile care șterg local la redenumirea sau mutarea într-o cale ignorată necesită aceeași analiză (`1463`, `1599`).

**F4 — Pull manual dezabonează documentele și lasă evidența internă incorectă.**

După conectarea inițială, documentele sunt înregistrate în `joinedDocs`. La un pull ulterior, fiecare document este citit prin `joinDoc()` și apoi părăsit prin `leaveDoc()`, dar nu este eliminat din `joinedDocs`. Comanda manuală (`src/extension.ts:1205`) nu reface abonamentele. Chiar și apelarea ulterioară a `joinAllDocsForWatching()` le omite deoarece setul le consideră deja abonate (`1761`). Reproducerea confirmă că abonamentul serverului dispare, deși evidența locală rămâne pozitivă. Trebuie păstrat abonamentul existent la citirea documentului sau refăcute abonamentele, cu actualizarea coerentă a setului inclusiv la erori.

**F7 — Uploadul multipart nu acceptă toate valorile permise de tipul Uint8Array.**

`stream.Readable.from(fileContent)` emite numere dacă primește un Uint8Array obișnuit. Fluxul multipart/HTTP așteaptă fragmente de octeți și produce `ERR_INVALID_ARG_TYPE: ... Received type number (0)`. Am confirmat problema prin `BaseAPI.uploadFile()` real, cu bibliotecile instalate `form-data` și `node-fetch`, către un server HTTP pe loopback. Aceiași octeți funcționează când sunt transmiși ca Buffer. Contractul VS Code pentru `workspace.fs.readFile()` permite Uint8Array; codul nu poate presupune că rezultatul este întotdeauna Buffer. Remedierea poate normaliza explicit datele, de exemplu `Readable.from([Buffer.from(fileContent)])`, sau transmite Buffer direct în formular. Testul existent înlocuiește atât formularul, cât și fetch-ul, deci nu exercită această serializare.

**F5 — Pull nu actualizează arborele proiectului.**

`performPullAll()` iterează `this.fileTree`, fără să solicite o actualizare a listei de fișiere. În modul HTTP nu există evenimente Socket.IO care să mențină arborele actualizat. Un document adăugat în Overleaf după conectare nu este descărcat de un pull ulterior, deși operația raportează succes. Reproducerea verifică și faptul că `getProjectDetails()` nu este apelat. Lista trebuie actualizată înaintea sincronizării, folosind mecanismul disponibil pe server și păstrând baza anterioară necesară identificării ștergerilor. Aceeași lipsă afectează recuperarea după evenimente de structură ratate.

**F6 — Cache-ul este actualizat înainte de confirmarea uploadului.**

`shouldPropagate()` memorează hash-ul înaintea operației remote. Dacă uploadul eșuează, ramura de eroare nu invalidează valoarea. Un nou eveniment pentru exact aceiași octeți este ignorat ca ecou, deși serverul nu a primit conținutul. Reproducerea provoacă o eroare tranzitorie și emite apoi încă un eveniment: există o singură tentativă de upload, iar serverul rămâne la versiunea veche. Cache-ul pentru conținut confirmat trebuie separat de operațiile în curs sau restaurat la eșec. Recuperarea manuală prin pull și alegerea copiei locale rămâne posibilă; problema privește reluarea automată.

Verificări executate pe Windows, Node.js `v24.18.0`, npm `11.16.0`:

- `npm.cmd test`: compilare TypeScript, bundle, lint și testele existente au trecut.
- `npm.cmd audit --json`: zero vulnerabilități raportate de npm pentru dependențele instalate.
- `node docs/audits/reproduce-sync-findings.cjs`: toate cele 7 probleme au fost reproduse.

Scriptul inițial folosea implementarea compilată, nemodificată. F1–F6 utilizau un filesystem în memorie și un server simulat; F7 utiliza un server local și procese copil pentru izolarea excepției. După remediere, aceeași [comandă](reproduce-sync-findings.cjs) execută testele de regresie, fără acces la proiecte sau credențiale reale:

```powershell
npm.cmd run compile
node docs/audits/reproduce-sync-findings.cjs
```

În auditul inițial, mesajul `REPRODUCED` confirma prezența defectelor. Comanda actualizată verifică comportamentul corect și afișează `Passed` pentru grupurile de teste. Suita normală (`npm.cmd test`) include aceleași verificări.

Nu am executat un test complet în interfața VS Code cu un proiect Overleaf real și nici o matrice de versiuni self-hosted. Rezultatul npm audit privește baza sa de advisories; nu certifică securitatea întregului cod. Recomand ca remedierea să înceapă cu F1–F3, apoi F4/F7, urmate de recuperarea și actualizarea stării din F5–F6.
