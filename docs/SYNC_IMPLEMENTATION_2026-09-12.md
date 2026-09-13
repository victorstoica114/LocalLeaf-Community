# Implementarea sincronizării — candidat 0.2.12

Implementarea extinde versiunea 0.2.11 din workspace. Testele automate locale și cele 15 verificări finale pe proiectul `proba`, creat de utilizator, au trecut. Pachetul 0.2.12 a fost instalat local prin CLI-ul VS Code; fereastra utilizatorului necesită `Developer: Reload Window` pentru activare. Candidatul nu a fost publicat.

Pachet: `localleaf-community-0.2.12.vsix`, 14 fișiere, aproximativ 241 KiB. Au fost verificate versiunea, identitatea bundle-urilor față de build, licențele și excluderea fișierelor de test. Worker-ul extras din VSIX a executat cu succes un merge de verificare.

SHA-256: `4decd895153615b6c3ab1f675965ef0d66597c20003a35002f9e7e9f2afa37ef`.

## Comportament implementat

- Evenimentele filesystem sunt grupate pe cale și clasificate din nou după starea curentă. Directoarele nu mai ajung la citirea conținutului unui fișier. O verificare suplimentară a dimensiunii și timpului de modificare reduce uploadurile intermediare ale fișierelor generate.
- Strămoșul comun, hashul, identitatea remote și versiunea se păstrează în stocarea extensiei, separat pentru server/proiect/workspace. Fiecare înregistrare este înlocuită atomic, după scrierea și sincronizarea fișierului temporar. Lipsa conținutului unui strămoș nu este interpretată ca text gol.
- Intențiile de scriere OT, ștergere și înlocuire a atașamentelor sunt persistate înaintea operației de rețea. Recuperarea unui atașament verifică identitățile și hashurile înainte de a elimina copia de rezervă; o stare ambiguă păstrează copiile.
- Auto-merge folosește `node-diff3@3.2.1` pentru `.tex`, `.bib`, `.md`, `.sty` și `.cls`, cu tokenizare care păstrează newline-urile și spațiile. Un worker are termen de 1,5 secunde și buget de heap de 128 MiB. Sunt admise cel mult două lucrări simultane. Pentru auto-merge, fiecare versiune este limitată la 2 MiB.
- `diff@8.0.4` produce operații granulare. Pozițiile și lungimile trimise Overleaf folosesc unități UTF-16, inclusiv pentru text cu emoji. Un diff prea costisitor păstrează conținutul pentru review.
- Lockul pe cale asigură o singură scriere activă a documentului. Versiunea trimisă rămâne legată de snapshotul folosit la calcularea operației. Serverul Overleaf transformă operația față de editările concurente; după confirmare, clientul recitește snapshotul și reconciliază salvările locale apărute între timp.
- Confirmarea RPC de punere în coadă nu este tratată ca o confirmare de aplicare. După pierderea confirmării se verifică snapshotul sau se reia operația jurnalizată cu `dupIfSource`, conform protocolului Overleaf. O operație refuzată explicit cu `Op too old` trece prin rebase și merge, cu un număr limitat de încercări.
- Drafturile editorului se modifică prin `WorkspaceEdit`, rămân nesalvate și nu sunt încărcate automat. O schimbare apărută în timpul merge-ului invalidează aplicarea rezultatului vechi.
- Reconcilierea periodică cere un arbore actual de proiect. Identitățile persistate permit recuperarea unor mutări sau redenumiri ratate cât timp workspace-ul era închis. O ștergere remote se aplică automat unei copii locale neschimbate; editările locale divergente rămân pentru review.
- Refresh-ul arborelui prin protocolul query invalidează vechile abonamente și snapshoturi. O verificare programată după eliberarea lockurilor reface abonamentele și aplică editările ratate în timpul reconectării. Ecourile locale ale redenumirilor și ștergerilor remote nu mai declanșează reconectări inutile.
- Regulile de ignore pentru directoare sunt reevaluate după determinarea tipului căii, inclusiv la ștergere. O copie sincronizată care lipsește local nu este recreată de verificarea din fundal: ștergerea este reevaluată după debounce și se propagă numai dacă identitatea și conținutul remote permit operația.
- Erorile sunt reținute pe fișier și nu dispar doar pentru că alt fișier s-a sincronizat. Schimbările concurente ale atașamentelor nu mai sunt înlocuite automat fără verificare.

## Verificări efectuate

`npm test` rulează verificarea TypeScript, ESLint, contractele existente de UI și sincronizare, 19 grupuri de regresii pentru motor și integrarea cu două motoare independente.

| Scenariu | Rezultat local |
|---|---|
| Auto-merge la salvare, pull și eveniment remote | Trece; ambele copii converg fără dialog |
| Whitespace, CRLF, Unicode, newline final | Trece în testele algoritmului |
| Schimbări suprapuse și ștergere versus editare | Copiile sunt păstrate pentru review |
| Multe linii repetitive | Worker-ul este oprit la termen |
| Draft nesalvat | Merge prin editor, fără scriere pe disc și fără upload |
| Salvare nouă în timpul uploadului | Convergență sau conflict păstrat, fără avansarea unei baze false |
| Restart și strămoș comun persistent | Trece cu două directoare reale și două motoare |
| Confirmare pierdută după commit | Textul nu se dublează; jurnalul se închide după recuperare |
| Operație OT prea veche | Rebase și merge cu snapshotul actual |
| Atașament întrerupt înainte/după upload | Restaurare sau finalizare numai după verificarea copiilor |
| Evenimente pentru directoare și scrieri rapide | Fără citirea directoarelor; o singură revizie finală este trimisă |
| Cinci reconectări consecutive ale motorului | Editările ulterioare continuă să ajungă la celălalt client |
| Refresh query fără pull complet | Abonamentele sunt refăcute și editările ratate sunt aplicate |
| Ștergere locală în timpul verificării din fundal | Fișierul nu reapare; o editare remote concurentă este păstrată |
| Ignore cu regulă numai pentru directoare | Nu creează directoare goale și nu propagă ștergeri excluse |
| Zece reconectări ale transportului și heartbeat expirat | Acoperite și de testele transportului existente |
| `npm audit` | Zero vulnerabilități raportate la verificare |

Testul cu două motoare folosește filesystem-ul real, watcher-e native și clientul Socket.IO efectiv, conectat la un server HTTP/WebSocket local. Transformarea serverului de test folosește tipul text ShareJS din Overleaf, sub licența MIT, la commitul `28ad3b03b71cb4311decdcb55c36b33ec10d72db`. Nu este o execuție a întregului server Overleaf.

## Validarea pe instanța utilizatorului

Validarea folosește proiectul de test `proba`, creat de utilizator pe instanța sa Overleaf. Adresa și identificatorul proiectului sunt păstrate în raportul local al rulării. `src/test/serverIntegrationExtension.ts` rulează în VS Code cu două instanțe reale ale motorului, două directoare locale distincte, watcher-ele VS Code și stocare persistentă separată. Autentificarea folosește API-ul normal SecretStorage al extensiei. Nu este necesară citirea sau decriptarea manuală a bazei interne VS Code.

Serverul folosește protocolul Socket.IO query. Rulările au reprodus trei probleme corectate în candidat: crearea unui director ignorat gol, pierderea abonamentelor la documente după refresh și recrearea unui fișier șters local când reconcilierea precede watcher-ul. Fiecare are acum regresie locală; verificarea ulterioară pe server a trecut.

Rularea finală, încheiată la `2026-09-12T18:19:16Z`, a trecut toate cele 15 verificări:

1. Creare remote și clonă goală fără dialog Local/Remote.
2. Salvare prin watcher-ele VS Code și actualizarea celui de-al doilea client.
3. Editări simultane independente cu auto-merge.
4. Restart cu strămoș persistent și editări offline.
5. Recuperarea unei confirmări întrerupte după commit, fără dublarea textului.
6. Cinci reconectări și editări ulterioare.
7. Refresh al arborelui fără pull complet, cu refacerea abonamentelor.
8. Creare locală de director și document.
9. Redenumire remote aplicată ambelor copii.
10. Excluderea directorului generat prin ignore.
11. Ștergere locală de fișier propagată pe server și al doilea client.
12. Ștergere locală de director propagată pe server și al doilea client.
13. Transferul unui CSV de 2.550.010 octeți fără retry manual.
14. Zece probe de sincronizare pe parcursul a 150 secunde, inclusiv după reconcilierea periodică de două minute, cu jurnalele de operații închise și fără erori inexplicabile pe fișiere.
15. Editări suprapuse pe aceeași linie: cele două variante sunt păstrate pentru review, iar conținutul remote nu este suprascris.

Raport: `.tmp-server-integration/2026-09-12T18-16-08-189Z/result.json`. Fișierele sunt în directorul remote `.localleaf-tests-2026-09-12T18-16-08-189Z`; fișierele existente ale proiectului sunt în afara regulilor de sincronizare ale celor doi clienți de test. Conflictul de la final este intenționat și a rămas în copiile de test pentru inspecție. [Instrucțiunile de repetare](SERVER_INTEGRATION.md) folosesc builderul păstrat în repository și un proiect de test ales explicit.

## Limite de verificare și comportament

Un merge textual curat nu verifică semantica LaTeX. Blocurile de linii adiacente pot rămâne conservator conflicte. Fișierele binare, strămoșii indisponibili și depășirea bugetelor cer review. Datele de sincronizare sunt locale; un alt PC își construiește propria bază prin primul pull.

Validarea pe server acoperă instanța și configurația concretă de mai sus. API-urile structurale Overleaf nu oferă o tranzacție comună cu filesystem-ul local; implementarea verifică din nou identitățile și conținutul și păstrează copiile ambigue. Nu a fost efectuat un test de anduranță de mai multe ore pe instanța utilizatorului.
