# Vertailut

Tämä dokumentti kokoaa yhteen, mihin L0/L1:tä on verrattu, mitä on mitattu ja
mitä ei. Yksityiskohdat ovat omissa dokumenteissaan; tässä on se, mitä
vertailuista seuraa.

Mitattu: FlatGeobuf (luku ja kirjoitus) ja RBush.
Analysoitu mittaamatta: OpenSearch Serverless, ClickHouse, Airphant ja LogCloud.

## Tiivistelmä

| | mikä se on | lukukierrokset | kirjoitus | kylmäkäynnistys | tarvitsee prosessin | selaimessa |
|---|---|---|---|---|---|---|
| **L0 + L1** | muuttumaton artefakti + absoluuttinen delta | **2** lämpimänä, 4 kylmänä | delta, ~130 B/muutos | 2 kierrosta + katalogi (1,1–1,4 MB / 1 M) | ei | kyllä |
| FlatGeobuf | muuttumaton tiedosto, pakattu Hilbert-R-puu | 5–12 | koko tiedosto uudelleen | ~13 kB header | ei | kyllä |
| RBush | dynaaminen R-puu muistissa | 0 (muistissa) | 3–40 µs, ei kestävä | ~2,2 s / 1 M kohdetta | **kyllä** | rajallisesti |
| OpenSearch Serverless (klassinen) | hakuklusteri | palvelin | heti | ei sammu, ~350 $/kk lattia | kyllä | ei |
| OpenSearch Serverless NextGen | hakuklusteri, skaalautuu nollaan | palvelin | heti | **10–30 s** | kyllä | ei |
| ClickHouse | sarakevarasto, MergeTree | metatiedot → marks → granulet | insert-partit, patch-partit | binäärin ja partien avaus | kyllä | ei |

Lyhyesti: **L0 on ainoa, joka on samaan aikaan ilman prosessia, vakiokierroksinen
ja päivitettävä.** Jokainen muu luopuu yhdestä näistä:

- FlatGeobuf luopuu vakiokierroksista ja päivitettävyydestä.
- RBush, OpenSearch ja ClickHouse luopuvat prosessittomuudesta.

L0:n hinta on rajoitetumpi kyselykieli, ei relevanssia ja suurehko katalogi
kylmäkäynnistyksessä.

## Yhteinen asetelma (mitatut)

- **Aineisto:** synteettinen, ETRS-TM35FIN-laatikko. 1 000 000 pistettä ja
  1 000 000 polygonia (84 % 5–30 m, 15 % 50–500 m, 1 % 2–30 km). 70 % kohteista
  on kaupunkirykelmissä.
- **Näkymät** tiheimmän rykelmän keskeltä: koko maa, 200 km, 20 km, 2 km, 200 m.
- **Verkko** simuloitu kaikille samoin: 30 ms per pyyntö, 100 MB/s per yhteys.
- **Oikeellisuus:** jokaisen haun tulosmäärä tarkistettu raa'alla
  läpikäynnillä, kirjoitusten jälkeen myös luokittaiset määrät.
- **Toisto:** `tools/vertailut/` (README).

## FlatGeobuf

Lähin vastine paikkatiedossa: yksi muuttumaton tiedosto, Hilbert-järjestys,
HTTP Range -luku selaimessa. Täysi raportti on `vertailu-flatgeobuf.md`:ssä.
Vertailua varten L0:aan lisättiin `geo_bounding_box`, jotta molemmat vastaavat
samaan kysymykseen (mitkä kohteet, joiden laatikko leikkaa näkymää).

**Luku, polygonit, kokoluokka ennen Hilbertiä** (kierrokset / tavut; L0 lämpimänä):

| näkymä | osumia | FlatGeobuf | L0 |
|---|---|---|---|
| 200 km | 291 966 | 12 / 96,1 MB | 2 / 30,3 MB |
| 20 km | 98 447 | 12 / 35,5 MB | 2 / 11,2 MB |
| 2 km | 2 310 | 8 / 2,1 MB | 2 / 649 kB |
| 200 m | 745 | 8 / 871 kB | 2 / 277 kB |

**Kirjoitus**, 1 000 000 polygonia:

| | FlatGeobuf | L0 + L1 |
|---|---|---|
| kirjoitettu per flush | 306,7 MB (koko tiedosto) | 137 kB (1 000 muutosta) – 13 MB (100 000) |
| rakennusaika per flush | 11,5 s | 23 ms – 0,7 s |
| lukijoiden välimuisti | vanhenee kokonaan | säilyy, vain delta on uutta |
| lukukierrokset muutoksen jälkeen | ennallaan | ennallaan (2) |

Mitä tästä seuraa:

1. **Kierrosero johtuu rakenteesta.** R-puu luetaan taso kerrallaan, ja
   jokainen solmualue on edellisestä riippuva haku. L0 laskee välit muistissa.
2. **Indeksit ovat samaa kokoluokkaa** (40 vs 32 B/kohde). Tavuero (2–4×) tulee
   pääosin geometrian ja attribuuttien koodauksesta, ei indeksistä.
3. **Isot ja pienet kohteet sekaisin ovat kummankin ongelma.** Kokoluokka
   avaimen alkuun pudotti 200 m näkymän 45 MB:stä 0,87 MB:hen (FlatGeobuf) ja
   15 MB:stä 0,28 MB:hen (L0).
4. **FlatGeobuf voittaa yksittäisessä kylmässä haussa:** ~13 kB header vs
   L0:n 1,1–1,4 MB katalogi.
5. **Muutoksen hinta on L1:llä verrannollinen muutokseen, FlatGeobufilla
   koko aineistoon.** Ero on noin kolme kertaluokkaa per muutos.

## RBush

Dynaaminen R-puu muistissa. Se ei ole tallennusmuoto vaan indeksi, jonka
joku prosessi pitää muistissa. Siksi se on vertailukohta vaihtoehdolle "pidä
prosessi lämpimänä", jota L0 välttää. Samat 1 000 000 polygonia
(`tools/vertailut/rbush.mjs`):

| | RBush |
|---|---|
| ladattava data (laatikot + rivinumero, binääri) | 36 MB |
| dekoodaus + bulk load | 0,49 s + 1,65 s |
| kylmäkäynnistys yhteensä (30 ms + siirto + rakennus) | ~2,2 s (1 GB/s) – 2,5 s (100 MB/s) |
| muisti V8:ssa | ~172 B/kohde (136 MB kohteet + 36 MB puu) |
| haku 200 m / 2 km / 20 km / 200 km | 0,36 / 0,51 / 3,2 / 12 ms |
| lisäys / siirto / poisto | 3,0 / 40 / 30 µs per operaatio |

Mitä tästä seuraa:

1. **Lämpimänä RBush on kaksi kertaluokkaa nopeampi** (0,4 ms vs L0:n noin
   60 ms pienessä näkymässä), ja kirjoitukset ovat mikrosekunteja.
2. **Kylmäkäynnistys kasvaa aineiston mukana.** Miljoonalla kohteella se on
   noin 2,2 s, eli samaa luokkaa kuin NextGenin kylmäkäynnistyksen alapää, ja
   se kasvaa lineaarisesti.
3. **Katkeamispiste:** noin 2,2 s / (60 − 0,4 ms) ≈ **35 hakua** samassa
   lämpimässä ympäristössä, ennen kuin RBush on kokonaisviiveessä edellä. Mittari
   on siis "hakuja per kylmäkäynnistys", ja vastaus riippuu kuormasta.
4. **Muistiraja:** noin 172 B/kohde pelkälle indeksille. Lambdan 10 GB:n
   rajalla katto on luokkaa kymmeniä miljoonia kohteita. Kohteiden data
   muistissa pudottaa sen moninkertaisesti, ja selaimessa käytännön raja on
   muutamia miljoonia.
5. **RBush palauttaa vain rivinumerot.** Kohteiden data on joko muistissa
   (lisää muistia) tai haettava erikseen (silloin ollaan L0:n toisessa aallossa).
6. **Kirjoitukset eivät ole kestäviä** eivätkä yhteisiä rinnakkaisten
   ympäristöjen kesken. Kestävyys vaatii erillisen tallennuksen, eli L2-tason,
   jolla tämä lähestymistapa `idx_research.md` §8:n mukaan loppuu.

**Yhdistelmä, jota ei ole vielä toteutettu:** RBush L1-deltan indeksinä. Delta
on pieni, valmiiksi muistissa ja kestävä (se on S3:ssa), joten sen puu on halpa
rakentaa. Nyt deltan lineaarinen läpikäynti nosti 10 %:n muutoksella 200 m
näkymän laskenta-ajan 1,3 ms:stä 11,7 ms:iin. FlatGeobufin indeksi on
käytännössä Flatbush (saman tekijän staattinen pakattu R-puu), joten jako
"staattinen rakenne baselle, RBush deltalle" on luonteva.

## OpenSearch Serverless (ei mitattu tässä)

Lähde: `idea.md`, joka viittaa AWS:n julkaisuihin.

- **Klassinen:** ei skaalaudu nollaan. Tuotantokokoonpanon lattia on noin
  350 $/kk ennen tallennusta, käytöstä riippumatta.
- **NextGen** (GA 28.5.2026): skaalautuu nollaan, mutta ensimmäinen pyyntö
  odottaa **10–30 s**.
- **L0:** ensimmäinen kysely 2 kierrosta (63 ms mitattuna 30 ms:n viiveellä),
  lattia on pelkkä tallennus. Verkkokauppaesimerkissä 0,42 $ tuhatta istuntoa
  kohti; klassisen lattian hinnalla saisi noin 830 000 istuntoa kuukaudessa.
- **OpenSearch tarjoaa** sen, mitä L0 ei: relevanssi (`_score`), välitön
  näkyvyys kirjoituksille, rivikohtaiset käyttöoikeudet ja laaja kyselykieli.

## ClickHouse (ei mitattu)

Analyysi `docs/l1-malli.md` §13:sta ja suunnittelukeskustelusta.

- **Samaa sukua:** muuttumattomat lajitellut osat, harva indeksi ja
  taustamerget. L1:n patch-malli vastaa ClickHousen patch-partteja (25.7), jotka
  tunnistavat rivin `(part, offset)`-parilla.
- **Ero:** ClickHouse olettaa prosessin, joka omistaa osien listan, ja optimoi
  läpäisyä. S3:lla se lukee osan metatiedot, sitten marks-tiedostot ja vasta
  sitten granulet. Nämä ovat riippuvia kierroksia, joita se piilottaa solmun
  välimuistilla. Selaimessa se ei toimi.
- **Lambdassa** se ajetaan `clickhouse-local`-binäärinä tai chDB-kirjastona,
  jolloin kylmäkäynnistys ja muisti ovat raskaampia kuin L0-lukijalla.
  Kirjoittaminen Lambdasta vaatii silti pysyvän kirjoittajan ja manifestin.
- **ClickHouse tarjoaa** SQL:n, joinit, laajat aggregoinnit, pakkauksen ja
  korkean kirjoitusnopeuden.
- **Johtopäätös:** järkevin rooli olisi kirjoittajana ja totuuden lähteenä,
  josta L0-artefaktit rakennetaan, jos kirjoitusmäärä kasvaa niin suureksi, että
  merge-politiikasta tulee oikea ongelma.

## Kirjallisuus: lähimmät julkaistut työt (ei mitattu)

- **Airphant** (Chockchowwat, Sood, Park; ICDE 2022): pilvitallennuksen
  hierarkkiset indeksit maksavat monta kierrosta, joten rinnakkaiset haut ja
  yliluku hyväksytään. Ydinajatus on sama kuin L0:n, mutta vain avainsanahaulle,
  todennäköisyyspohjaisella sketsillä ja ilman päivityksiä.
- **LogCloud** (Wang ym., PVLDB 18, 2025): osamerkkijonohaku objektitallennuksen
  lokeista FM-indeksillä. Uusi data indeksoidaan erissä ja indeksoimaton häntä
  skannataan, mikä vastaa L1:n "kuuma delta ilman indeksiä" -mallia.
- **Durner, Leis, Neumann** (PVLDB 16, 2023): objektitallennuksen viive- ja
  kaistamalli, johon L0:n kierrosperuste nojaa.
- **Iceberg / Delta Lake:** manifesti ja CAS-osoitin. L1:n root ei ole uutta.

Tämän perusteella L0:n oma kontribuutio ei ole "kierrokset ratkaisevat", vaan
(1) niiden kyselyluokkien karakterisointi, joille riittää O(1) riippuvaa
kierrosta, kun katalogin koko on rajattu (`l1-malli.md` §9.1), ja (2) rajan
säilyminen päivityksissä.

## Mitä jäi mittaamatta

- Oikea S3 tai CDN; nyt verkko on simuloitu.
- Oikea aineisto vertailuissa. MML- ja ajoneuvoaineistot on mitattu vain
  L0:lla omissa raporteissaan.
- OpenSearch Serverless ja ClickHouse samalla aineistolla, erityisesti
  `clickhouse-local` Lambdassa: kylmä ja lämmin kysely S3:sta.
- Selaimen jäsennysaika ja muistinkäyttö L0-katalogille.
- RBush L1-deltan indeksinä (yllä).
