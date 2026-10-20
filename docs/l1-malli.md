# L1-malli: kirjoitukset ilman palvelinta

> L1-indeksi on lista muuttumattomia sivuja ja yksi muuttuva osoitin.
> Kirjoittaja ei koskaan muuta mitään, mitä lukija voi nähdä — se kirjoittaa
> uutta ja siirtää osoitinta.

Tämä dokumentti kuvaa L1:n rakenteen siinä muodossa, jossa se on tarkoitus
toteuttaa. `idx_research.md` §7 määrittelee L1:n sopimuksen (näkyvyys
rajatulla viiveellä, ei elävää prosessia lukupolulla); tämä kertoo miten se
toteutetaan niin, että L0:n kaksi kierrosta säilyy.

**Tila: suunniteltu, ei toteutettu.** Mittaussuunnitelma on §11:ssä.

## 1. Rajaus

L1 = *eventually available*. Kirjoitus näkyy lukijalle viiveellä

```
viive ≈ jonon puskurointi + flush + root-osoittimen TTL
```

L2 (read-your-writes) jää tietoisesti pois: se vaatisi lukijan näkevän
kirjoittajan puskurin, eli jaetun muuttuvan tilan (§8 `idx_research.md`).

Kirjoituskuorma oletetaan maltilliseksi ja yhden kirjoittajan jonoon
mahtuvaksi. Jos päivitysnopeus × kompaktointiväli kasvaa niin suureksi, että
kompaktointi on käytännössä jatkuvaa, L1 on väärä malli.

## 2. Mitä L0:ssa muuttuu ja miksi

L0-artefakti on yksi tiedosto: sektiot, katalogi, 16 tavun footer. Footer
sitoo navigaattorin ja datan samaan objektiin, joten mikä tahansa muutos on
koko objektin uusi versio.

Toinen, mitattu ongelma: **katalogi kasvaa arvojen määrän mukana.**
Ajoneuvoaineistossa (5,3 M dokumenttia) katalogi on 18,7–24,9 MB, josta yksi
kenttä (`kaupallinenNimi`, 96 521 mallinimeä) vie 7,38 MB
(`idx_research.md` B.5). Navigointiin oikeasti tarvittava osa — harva indeksi
ja klusterointirajat — on noin 0,07 MB. Loput on dataa (avainsana-arvoja)
ja osoitteita, jotka L0:n sääntö *"kaikki mikä tarvitaan tavualueen
laskemiseen on katalogissa"* veti katalogiin.

Sääntö korvataan tiukemmalla (§4).

## 3. Objektit

```
root              pieni, ainoa muuttuva, CAS (If-Match)       Cache-Control: max-age=10..60
 ├─ base-katalogi   iso, muuttuu vain kompaktoinnissa         immutable, sisältöosoitettu
 ├─ delta-katalogi  pieni, muuttuu joka flushissa              immutable, sisältöosoitettu
 └─ packit          sivuja, kirjoitetaan kerran                immutable, sisältöosoitettu
```

**Root** korvaa footerin:

```
{ version, baseCatalog: <hash>, deltaCatalog: <hash> | inline, packs: [<hash>…] }
```

Pieni delta-katalogi upotetaan rootiin, jolloin yksi haku jää pois.

**Katalogi on sivutaulu**: `(kenttä, sivu) → (pack, offset, pituus)` sekä
harvat indeksit, klusterointirajat, raskaat arvot (§4) ja tilastot.

**Pack** on monen sivun objekti, luettava range-pyynnöillä (vrt. gitin
packfile). Flush kirjoittaa uuden packin, jossa on vain muuttuneet sivut.
Olemassa olevaan packiin ei kosketa.

Kaikki paitsi root on sisältöosoitettua ja `immutable`. Välimuistiargumentti
(`billing.md`) pätee sellaisenaan.

**L0 on L1:n erikoistapaus:** yksi pack, tyhjä delta. Valmiin version voi
aina koota yhdeksi L0-tiedostoksi jakelua varten.

## 4. Katalogin kokosääntö

> Katalogissa on kaikki, mikä tekee osoitteen riippumattomaksi datasta —
> mutta sen koko saa riippua vain skeemasta, sivumäärästä ja N/T:stä,
> ei arvojen määrästä.

Seuraukset:

**Sanakirjat ovat dataa.** Avainsanakentän arvot tallennetaan lajiteltuina,
front-koodattuina sanakirjasivuina packiin. Katalogissa on joka 128. arvo
(harva näyte), samalla periaatteella kuin numeeristen sarakkeiden harva
indeksi. `kaupallinenNimi`: 96 521 arvoa → noin 754 katalogimerkintää.

**Raskas/kevyt-raja T.** Arvo, jolla on yli T dokumenttia, saa osoitteensa
katalogiin (bittikartan sijainti ja count). Kevyen arvon id-lista upotetaan
sanakirjasivulle arvon viereen. Silloin

- raskaita arvoja on enintään N/T (N = 5,3 M, T = 1000 → ≤ 5 300), riippumatta
  kardinaliteetista;
- kevyen arvon `term` on yksi haku (sanakirjasivu, jossa id-lista on mukana);
- raskaan arvon `term` on yksi haku (bittikartta, osoite katalogista).

**Matalan kardinaliteetin kentät** (alle sivullisen arvoja) pysyvät
katalogissa kokonaan; sivutus koskee vain korkean kardinaliteetin kenttiä.

**Binäärikoodaus.** Katalogi on binääri (varint, delta-koodatut offsetit,
sektion nimi johdetaan `(kenttä, arvon indeksi)` -parista eikä tallenneta).
Tämä on vakiokerroin (arvio 5–6×) ja hyöty on lähinnä parse-ajassa
(B.5: 84 ms 128 ms:stä oli `JSON.parse`). Rakennemuutos on asymptoottinen:
`kaupallinenNimi` 7,38 MB → noin 11 kB.

**Base- ja delta-katalogi ovat erillisiä tiedostoja.** Base haetaan
kokonaan ja voidaan tarjoilla brotli-pakattuna (range-pyyntöihin CDN ei
pakkaa). Jokainen uusi versio maksaa lukijalle vain delta-katalogin.

## 5. Rakenneluokat

Kirjoitettavuuden ratkaisee rakenteen osoitustapa, ei tietotyyppi.

| Luokka | Esimerkit | Lisäys | Päivitys / poisto |
|---|---|---|---|
| **A** docID-osoitteinen, kiinteä leveys | bittikartat, `exists`, live-maski, forward-sarakkeet, offset-taulut | häntään | ylikirjoitus tai patch |
| **B** arvojärjestetty | lajiteltu numeerinen sarake + docs, trigrammipostitukset, sanakirjat | delta-ajot (LSM) tai väljä B+puun lehti | poisto + lisäys järjestykseen |
| **C** vaihtuvamittainen | tallennetut kentät, tekstiarvot | häntään | uusi versio häntään, offset päivitetään (lokirakenne) |

A ja C ovat halpoja. Kaikki vaikea on B:ssä, joten rakenne pyrkii siirtämään
mahdollisimman paljon A:han.

### 5.1 Muutoksen kolme kokoluokkaa

| Muutos | Sijainti | Lisälukuja |
|---|---|---|
| pieni (muutamia satoja docID:tä per kenttä) | inline delta-katalogissa | 0 |
| keskikokoinen | diff-lohko uudessa packissa | +1 range samassa aallossa |
| suuri | koko sivu kopioidaan (COW) uuteen packiin | 0 (sivu korvataan) |

Kirjoittaja valitsee kokoluokan; lukija ei tarvitse tietoa valinnan syystä.

### 5.2 Diffit ovat absoluuttisia

Diff on muotoa `set: [...] / clear: [...]` tai *kentän uusi arvo*, ei XOR.
Absoluuttinen diff on idempotentti: sen voi soveltaa uudelleen ja eri pohjaan
(kompaktoinnin rebase, §8) ilman että tulos muuttuu.

### 5.3 Päivitys säilyttää docID:n

Päivitys on patch samaan docID:hen. Poisto + lisäys (Lucenen tapa) siirtäisi
dokumentin häntään ja rikkoisi klusteroinnin: muokattu vuoden 2019 tietue
päätyisi vuoden 2026 docID:iden joukkoon. Poisto + lisäys tehdään vain, kun
**klusterointiavain itse muuttuu**.

Tämä vastaa ClickHousen patch-partteja (25.7), jotka tunnistavat rivin
`(part, offset)`-parilla.

## 6. Kenttätyypit

| Tyyppi | Rakenne | Lisäys | Päivitys | Poisto |
|---|---|---|---|---|
| boolean / `exists` | bittikartta (A) | bitti häntään | set/clear-diff | live-maski |
| keyword, matala kard. | bittikartta per arvo (A) + forward-sarake (A) | bitti arvon karttaan | vanhan arvon clear + uuden set (vanha arvo forward-sarakkeesta) | live-maski |
| keyword, korkea kard. | sivutettu sanakirja, kevyet inline, raskaat bittikarttoina; forward-sarake (A) | uusi arvo / id delta-sanakirjaan | kuten yllä | live-maski |
| numeerinen | lajiteltu sarake + docs + harva indeksi (B); forward-sarake (A) | delta-ajo | dirty-maski + uusi arvo delta-ajoon | live-maski |
| klusterointiavain | implisiittiset docID:t | kronologisesti: häntään ilmaiseksi | **poisto + lisäys** | live-maski |
| teksti (wildcard) | base: trigrammipostitukset; delta: ei indeksiä | arvo delta-arvoihin | dirty-maski + uusi arvo | live-maski |
| tallennetut kentät | offset-taulu (A) + payloadit (C) | häntään | uusi payload, offset päivitetään | live-maski |
| live-maski | bittikartta (A) | bitti 1 | — | bitti 0 |

Huomioita:

- **Forward-sarake on pakollinen** päivitettäville kentille. Käänteinen
  rakenne (arvo → docs) ei kerro dokumentin *vanhaa* arvoa, jota tarvitaan
  vanhan merkinnän poistamiseen. Sama forward-sarake palvelee sekä
  kirjoittajaa (§7) että lukijaa (lajittelu, korkean kardinaliteetin `terms`).
- **Kenttätyyppi jäätyy baseen.** Delta ei saa muuttaa kentän tyyppiä
  (keyword ↔ text) eikä päätellä sitä uudelleen.
- **Tekstin vanhentuneita postituksia ei poisteta.** Wildcard varmennetaan
  aina arvoja vasten, joten vanhentunut postitus on vain väärä ehdokas.
  Dirty-maski ohjaa varmennuksen uusimpaan arvoon.
- **Delta-taso ilman indeksiä.** 10 000 dokumenttia × 100 tavua = 1 MB;
  skannaus on halvempi kuin indeksin ylläpito. Jos delta kasvaa yli
  skannausbudjetin, käytetään grammi × granule -bittikarttaa (A-luokka,
  81 tavua per grammi 5,3 M dokumentilla), ja tarkka indeksi rakennetaan
  kompaktoinnissa.
- **Base valitsee rakenteensa lukemisen ehdoilla**, koska sitä ei koskaan
  kirjoiteta paikallaan. Suffiksitaulukko on basessa mahdollinen, vaikka se
  ei sovi deltaan.

## 7. Kirjoituspolku

```
SQS FIFO (yksi message group)
   → kirjoittaja-Lambda (reserved concurrency 1, batching window)
       → lukee julkaistua indeksiä range-lukijalla:
           pk → docID          (pk-sanakirja, §4)
           vanhat arvot        (forward-sarakkeet, §6)
         /tmp = sivuvälimuisti, ei tilaa
       → flush:
           PUT pack-<hash>          muuttuneet sivut, diff-lohkot, muuttuneiden pk:t
           PUT delta-<hash>         sivutaulun muutokset, inline-diffit
           PUT root  If-Match       uusi versio + lastSeq
       → SQS-kuittaus vasta root-PUTin jälkeen
```

- **Kolme PUTia per flush**, muutosten määrästä riippumatta.
- **Kirjoittajalla ei ole omaa pysyvää tilaa.** Pysyvä tila on julkaistu
  indeksi (S3) ja julkaisemattomat operaatiot ovat jonossa (SQS). Lambdan
  `/tmp` häviää ympäristön kierrätyksessä, joten se on vain välimuisti;
  kylmäkäynnistys tarkoittaa tyhjää välimuistia, ei menetettyä tilaa.
- **pk on uniikki korkean kardinaliteetin avainsana** ja tallennetaan
  sivutettuna sanakirjana kuten muutkin (§4).
- **Oplog on delta-packeissa:** jokainen delta tallentaa muuttuneiden
  dokumenttien pk:t, joten rebuild voi toistaa muutokset > V pk:lla (§8).
- **Kaatuminen root-PUTin ja kuittauksen välissä** johtaa uudelleenkäsittelyyn.
  Absoluuttiset diffit (§5.2) ovat idempotentteja, ja root sisältää
  `lastSeq`:n, jota pienemmät tai yhtä suuret viestit ohitetaan.
- **EFS ei ole tarpeen.** Se olisi perusteltu vain, jos kirjoittajan
  välimuistin lämmitys julkaistusta indeksistä osoittautuisi mitattuna liian
  hitaaksi.
- **Root-osoittimella on yksi omistaja** (kirjoittaja). Kompaktori ei
  kirjoita rootia (§8).
- **docID:n jako:** uusi dokumentti saa seuraavan vapaan docID:n hännästä, ja
  sen klusterointiavaimen on jatkettava järjestystä: `(avain, pk)` on suurempi
  kuin hännän. Ei-kronologinen lisäys hylätään (`L1OrderError`), koska häntään
  päällekkäisellä aikavälillä se rikkoisi klusterointijärjestyksen — suodatus
  pysyisi oikeana, mutta lajittelu, `search_after` ja histogrammin docID-välit
  eivät. Sellainen lisäys vaatii rebuildin (§8) tai granulekohtaisen väljyyden.
  (Aiempi versio tästä kohdasta väitti oikeellisuuden säilyvän; vaihe 1 osoitti
  sen vääräksi järjestyksen osalta.)

## 8. Kompaktointi

Kompaktointi kirjoittaa uudet packit ja base-katalogin **rinnalle** eikä
koske olemassa oleviin objekteihin.

| | Fold | Rebuild |
|---|---|---|
| Mitä | diffit sovelletaan sivuihin; poistetut jäävät reiksi (`live = 0`) | uudelleennumerointi, reiät pois, uudelleenklusterointi |
| docID:t | vakaat | muuttuvat |
| Rebase | delta-merkinnät ≤ V pudotetaan | deltojen muutokset > V toistetaan pk:lla uutta basea vasten |
| Kesto | nopea, voi olla osittainen (sivu- tai kenttäkohtainen) | pitkä (MML-rakennus 4 h 41 min) |
| Missä | kirjoittaja-Lambda | Fargate / Batch |

Kulku:

1. Kompaktori ottaa tilannekuvan versiosta V ja kirjoittaa uudet packit ja
   base-katalogin, lopuksi merkin `base@V valmis: <hash>`.
2. Kirjoittaja huomaa merkin seuraavassa flushissa, tekee rebasen ja
   kirjoittaa rootin, joka osoittaa uuteen baseen.
3. Vanhat packit poistetaan, kun mikään root viimeisen grace-jakson ajalta ei
   viittaa niihin (≥ root-TTL + pisin kysely + selaimen istunto).

Osittainen fold kirjoittaa vain paljon muuttuneet sivut uuteen packiin ja
päivittää vain niitä vastaavat sivutaulun rivit — tämä edellyttää, että myös
base-katalogi on sivutettu (§12).

## 9. Lukupolku

- **Kylmänä:** root ja base-katalogi. Jos base-hash on upotettu sivuun tai
  Lambdan ympäristöön, molemmat haetaan samassa kierroksessa; ristiriidassa
  base haetaan uudelleen.
- **Lämpimänä:** root validoidaan TTL:n mukaan; muu on välimuistissa.
- **Kysely:** aalto 1 = base-sivut + pack-diffit + live-maski + delta-arvot;
  aalto 2 = tulosrivit. Inline-diffit ovat jo muistissa.
- **Monotonisuus:** lukija ei hyväksy rootia, jonka versio on pienempi kuin
  viimeksi nähty.

Lukija laskee sivulle `base` → sovella absoluuttiset diffit versiojärjestyksessä
→ AND `live`.

### 9.1 Mitkä kyselyt pysyvät O(1)-kierroksessa

Ehto: **kierroksia on vakiomäärä täsmälleen silloin, kun mikään osoite ei
riipu toisen haun sisällöstä.**

| Luokka | Kyselyt |
|---|---|
| 0 lukua | `count` ilman suodatinta; `range` ja `histogram` klusterointiavaimella; raskaan arvon `term`-count; `from`-sivutuksen osoite klusterointijärjestyksessä (vaatii sivukohtaiset kumulatiiviset live-laskurit katalogiin) |
| 1 aalto, aina | boolean `term`/`exists`; keyword `term`/`terms` (T-säännöllä myös korkea kardinaliteetti); `prefix`; numeerinen `range`; `bool`-yhdistelmät; tarkka count; matalan kardinaliteetin `terms`-aggregointi |
| 1 aalto yleensä | `sort` toissijaisella kentällä suodattimen kanssa (syvyys arvioidaan); `wildcard` (varmennus: koko arvosektio samassa aallossa tai lisäkierros); korkean kardinaliteetin `terms` (koko forward-sarake tai lisäkierros) |
| ei O(1) | `from`-sivutus toissijaisessa järjestyksessä; datariippuvaiset ketjut (join) |

L1 kasvattaa **pyyntöjen** määrää (fan-out deltoihin), ei kierroksia, kunhan
delta-katalogi on muistissa.

## 10. Mitä L1 maksaa L0:aan verrattuna

- Yksi objekti → monta objektia. "Tiedosto on artefakti" pätee vain
  kootulle versiolle.
- Kyselyn pyyntömäärä kasvaa diff-rangejen ja live-maskin verran.
- Indeksiin tulee rakenteita, joita L0 ei tarvinnut: pk-sanakirja ja
  forward-sarakkeet päivitettäville kentille. Ne ovat kirjoittajan ainoa
  pysyvä tila, ja ne maksavat tilaa myös lukijalle.
- `idx_research.md` §7.4:n heikennykset (MPH vain baseen, globaali
  enkoodaus vain baseen) pätevät edelleen.

## 11. Mittaussuunnitelma

Ensimmäinen vaihe testaa ydinväitteen — **kaksi kierrosta säilyy deltan
kanssa** — pienimmällä mahdollisella muutoksella nykyiseen lukijaan.

**Vaihe 1: live-maski ja inline-diffit**, ilman packeja ja sivutusta.

- Rakentaja tuottaa nykyisen L0-artefaktin + erillisen delta-tiedoston:
  live-maskin muutokset, A-luokan set/clear-diffit, uudet tallennetut
  payloadit, delta-arvot tekstille ja numeerisille.
- Lukija soveltaa deltan katalogivaiheessa; aalto 1 lisää live-maskin ja
  tarvittaessa delta-rangeja.
- `test/reference.js` laajennetaan: referenssi ajaa saman operaatiojonon
  (insert/update/delete) tavallisille objekteille, ja jokaisen kyselyn —
  myös satunnaisten — on täsmättävä osumamäärältään ja järjestykseltään.

**Mittarit** (nykyinen `rounds` / `reads` / `bytes` -laskenta):

| Mittari | Hypoteesi |
|---|---|
| kierrokset | 2 lämpimänä, deltan koosta riippumatta |
| lukuja | + 1 (live-maski) + diff-rangeja vain keskikokoisille muutoksille |
| tavuja | kasvaa lineaarisesti deltan koon mukana; käännepiste = kompaktointikynnys |
| delta-katalogin koko | inline-kynnyksen funktio; mitataan 0,1 %, 1 %, 10 % muutosasteilla |
| tekstin skannausbudjetti | missä delta-koossa skannaus ohittaa trigrammi-indeksin tavuissa |

Korpukset: 1 500 dokumentin generoitu (`npm run gen`), 100 000 tuotteen
verkkokauppa (`idea.md` §4) ja tarvittaessa ajoneuvoaineisto.

### 11.1 Vaihe 1: tulokset

Toteutus: `src/l1/overlay.js`, `src/l1/writer.js`, lukijan `applyDelta()`.
Jokainen yhden kentän lehtipredikaatti P kentällä f arvioidaan muodossa
`P(base) ANDNOT dirty(f) OR scan(P, deltan dokumentit joissa f muuttui)`, ja
lopputulos AND `live`. Delta on kokonaan inline (resident).

**Oikeellisuus.** `test/l1.test.js` ajaa satunnaisen operaatiojonon (lisäys,
osittainen päivitys, korvaus, klusterointiavaimen siirto, poisto) sekä deltaan
että referenssiin ja vertaa 22 kiinteää ja 60 satunnaista kyselyä kolmessa
vaiheessa (20, 170 ja 770 operaatiota), toissijaisen lajittelun molempiin
suuntiin (koko, `from`/`size`, `search_after`), `terms`-aggregoinnin
numeerisine aliaggregointeineen ja histogrammin. Kaikki täsmäävät.
Testit tunnistavat rikotun logiikan: kun `ANDNOT dirty` tai live-maski
poistetaan, 7/14 testiä kaatuu. `tools/l1-measure.js` tarkistaa lisäksi
jokaisen kyselyn referenssiä vasten 100 000 ja 1 000 000 dokumentilla.

Sivulöydös: toissijaisen lajittelun `search_after` laskevaan suuntaan ei
saa luottaa siihen, että ankkuroitu väli ulottuu kursoriin asti. Nyt lukija
tarkistaa välin reunan ja hakee tarvittaessa koko sarakkeen.

**Mittaukset** (`node tools/l1-measure.js <N> 30`; 30 % lisäyksiä, 50 %
osittaisia päivityksiä, 20 % poistoja; 30 ms simuloitu viive per kierros):

| N | muutos | operaatioita | delta (JSON) | gzip | deltan docit | apply |
|---|---|---|---|---|---|---|
| 100 000 | 0,1 % | 100 | 15 kB | 2,3 kB | 64 | 0,6 ms |
| 100 000 | 1 % | 1 000 | 155 kB | 18 kB | 662 | 1,1 ms |
| 100 000 | 10 % | 10 000 | 1,4 MB | 154 kB | 6 156 | 7,6 ms |
| 1 000 000 | 0,1 % | 1 000 | 159 kB | 19 kB | 671 | 1,3 ms |
| 1 000 000 | 1 % | 10 000 | 1,5 MB | 167 kB | 6 387 | 7,1 ms |
| 1 000 000 | 10 % | 100 000 | 14,6 MB | 1,5 MB | 61 543 | 103 ms |

Kyselyt, 1 000 000 dokumenttia (kierrokset / lukuja / kB tyhjällä
välimuistilla; CPU-aika välimuistista, mediaani seitsemästä):

| kysely | base | 0,1 % | 1 % | 10 % |
|---|---|---|---|---|
| term bool | 2/2/135 · 0,3 ms | 2/2/135 · 0,7 ms | 2/2/135 · 0,9 ms | 2/2/135 · 6,5 ms |
| range numeric | 2/3/3531 · 6,1 ms | 2/3/3531 · 5,6 ms | 2/3/3531 · 6,4 ms | 2/3/3531 · 13,1 ms |
| term keyword | 2/2/144 · 0,3 ms | 2/2/144 · 0,4 ms | 2/2/144 · 0,9 ms | 2/2/144 · 4,9 ms |
| A+B+C | 2/20/43759 · 59 ms | 2/20/43759 · 63 ms | 2/20/43759 · 59 ms | 2/20/43769 · 72 ms |
| sort retryCount desc | 2/4/162 · 0,3 ms | 1/3/129 · 0,5 ms | 1/3/129 · 4,5 ms | 1/3/129 · 22 ms |
| terms agg sender | 1/12/1500 · 1,9 ms | 1/12/1500 · (83 ms)¹ | 1/12/1500 · 2,6 ms | 1/12/1500 · 5,9 ms |

¹ Yksittäinen poikkeama (todennäköisesti GC); muilla muutosasteilla 2–6 ms.

Mitä tästä seuraa:

1. **Kierrokset ja lukujen määrä eivät muutu millään muutosasteella.** Inline-
   deltalla tämä on rakenteen seuraus, ei sattumaa: delta ei lisää aaltoon
   yhtään tavualuetta. Hypoteesin "+1 luku live-maskille" oletus oli, että
   maski on packissa; inline se maksaa nolla. Toissijainen lajittelu putoaa
   jopa yhteen kierrokseen, kun sivun kaikki osumat ovat deltassa, koska niiden
   tallennetut kentät ovat jo muistissa.
2. **Hinta siirtyy tavuista kahteen muuhun paikkaan:** deltan kokoon (noin
   150 tavua JSONia ja noin 15 tavua gzipattuna per operaatio) ja CPU-aikaan
   (lehden skannaus on O(deltan dokumentit)). 1 000 000 dokumentilla 10 %
   muutos maksaa 14,6 MB residenttiä deltaa ja 5–20 ms lisää per kysely.
3. **Inline-kynnys on noin katalogin kokoluokka.** 1 % muutos 1 000 000
   dokumentilla (1,5 MB) on jo suurempi kuin itse katalogi (1,1 MB). Tätä
   suuremmat muutokset kuuluvat packin diff-lohkoihin (vaihe 2) tai
   kompaktointiin — juuri §5.1:n kokoluokkajako, nyt numeroina.
4. **Kirjoittajan pk-skannaus on vaiheen 1 suurin oikopolku:** 75 MB ja
   2,3 s 1 000 000 dokumentilla. Vaihe 3:n pk-sanakirja poistaa sen.

Mittaamatta jäi: deltan haku verkosta (vaiheessa 1 delta annetaan lukijalle
valmiina; sen siirto on edellä mitattu koko), selaimen jäsennysaika ja
oikea S3 (vain simuloitu viive).

**Vaihe 2:** root + sisältöosoitetut packit + COW-sivut.
**Vaihe 3:** sivutettu sanakirja ja T-sääntö; binäärikatalogi.
**Vaihe 4:** kirjoittaja-Lambda (SQS, /tmp-välimuisti, `lastSeq`) ja fold-kompaktointi.

## 12. Avoimet kysymykset

1. **T ja sivukoko.** Ehdotus T = 1000, sivu 64 kB (bittikarttasivu = 524 288
   dokumenttia). Isompi sivu pienentää sivutaulua mutta kasvattaa COW-kopiota.
2. **Skannausbudjetti** delta-tasolle — määrää kompaktointitiheyden.
3. **Base-hashin upotus selaimeen**, jotta kylmäaloitus on yksi kierros.
4. **Sivutetaanko myös base-katalogi** (juuri + kenttäkohtaiset
   katalogisivut). Maksaa kierroksen kentän ensimmäisellä käytöllä, mutta
   osittainen fold ja kylmäaloitus hyötyvät.
5. **Kumulatiiviset live-laskurit** sivuittain katalogiin, jotta
   `from`-sivutus pysyy nollan lukuun poistojen jälkeen.

## 13. Hylätyt vaihtoehdot

- **Paikallaan muokkaus EFS:llä lukijoille näkyvästi.** Kesken kyselyn
  tehty `pwrite` antaa revityn luvun, ja `immutable`-välimuisti lakkaa olemasta
  totta.
- **EFS/SQLite kirjoittajan forward-storena.** Tarpeeton, koska pk-sanakirja
  ja forward-sarakkeet ovat jo julkaistussa indeksissä; erillinen pysyvä
  tila olisi toinen totuuden lähde.
- **XOR-diffit.** Eivät ole idempotentteja; rebase kompaktoinnissa rikkoutuu.
- **Poisto + lisäys jokaiselle päivitykselle.** Rikkoo klusteroinnin (§5.3).
- **Arvot katalogissa.** Kasvaa kardinaliteetin mukana (§2, §4).
- **ClickHouse pohjana + OpenSearch-adapteri.** Ratkaisisi kirjoitukset,
  mutta tuo raskaan prosessin Lambdaan, poistaa selainpolun ja lisää
  riippuvia S3-kierroksia (part-metatiedot → marks → granulet).
  Kirjoittajana ja totuuden lähteenä mahdollinen myöhemmin, jos kirjoitusmäärä
  kasvaa niin suureksi, että merge-politiikasta tulee oikea ongelma.
