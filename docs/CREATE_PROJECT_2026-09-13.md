# Create New Project — 0.2.14

Funcția este disponibilă în antetul Projects, în Tools pentru un proiect deja conectat și prin comanda `LocalLeaf: Create New Project`.

Utilizatorul introduce numele. Proiectul este creat pe serverul proiectului activ sau pe serverul implicit dacă folderul nu este conectat. După creare, lista este actualizată și notificarea permite deschiderea în Overleaf. Pentru un folder local neconectat, `Link This Folder` reutilizează fluxul existent de asociere, confirmare și sincronizare. Asocierea unui proiect deja deschis nu este înlocuită.

Cererea autentificată este un singur `POST /project/new` cu numele și template-ul `blank`. Serverul întoarce `project_id`; proiectul inițial conține `main.tex`. Contractul a fost verificat în [controllerul Overleaf](https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Project/ProjectController.mjs#L298) și [crearea proiectului de bază](https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Project/ProjectCreationHandler.mjs). Validarea limitei de 150 de caractere și a separatorilor urmează [validarea Overleaf](https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Project/ProjectDetailsHandler.mjs#L117).

Clickurile repetate sunt reunite prin blocarea operației active. Anularea introducerii numelui nu trimite cererea. La un răspuns pierdut sau neclar, POST-ul nu este repetat automat; interfața cere verificarea listei. O notificare de succes neînchisă nu blochează alte operații. Asocierea pornită ulterior păstrează serverul și folderul originale și verifică din nou starea folderului înainte de salvare.

## Validare

- Testele API folosesc HTTP real pe loopback și verifică URL-ul, JSON-ul, CSRF, numele invalid, autentificarea, răspunsurile invalide, dispose și absența retry-ului POST.
- Testele UI verifică butonul în diferitele stări, comanda fără argumente arbitrare, dublul click și revenirea din starea ocupată la eroare.
- Testele comenzii execută codul compilat și verifică anularea, schimbarea autentificării/serverului/folderului în timpul dialogurilor, crearea unică, notificările neblocante și confirmările întârziate.
- Testul real pe server a creat proiectul `LocalLeaf create test 2026-09-13T08-34-41-358Z`; adresa și identificatorul proiectului sunt păstrate în raportul local al rulării. Au trecut cele patru verificări: ID valid, o singură intrare în lista autentificată, descărcarea lui `main.tex` într-un folder gol și uploadul automat al unei editări locale. Rularea s-a încheiat la `2026-09-13T08:35:09Z`.

Raportul testului real: `.tmp-server-integration/2026-09-13T08-34-41-358Z/result.json`. Proiectul nou și copiile locale sunt păstrate pentru inspecție. Instrucțiunile de repetare sunt în [SERVER_INTEGRATION.md](SERVER_INTEGRATION.md).

Întreaga suită `npm test` a trecut, inclusiv TypeScript, ESLint și regresiile existente de sincronizare. Pachetul `localleaf-community-0.2.14.vsix` are 14 fișiere și aproximativ 245 KiB; versiunea, bundle-urile, licențele și excluderile au fost verificate. A fost instalat local, iar hashurile fișierelor instalate corespund buildului verificat. Activarea în fereastra existentă necesită `Developer: Reload Window`.

SHA-256 VSIX: `cc8a476ab72f25192cc0a6d2a8d4c55e3e89fdafcbb4abfe383688c760a77470`.
