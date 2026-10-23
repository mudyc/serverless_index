# L0 ja FlatGeobuf: sama aineisto, samat näkymät

FlatGeobuf on lähin vastine L0:lle paikkatiedon puolella: yksi muuttumaton
tiedosto, Hilbert-järjestys, HTTP Range -luku selaimessa, ei palvelinta. Ero on
indeksissä. FlatGeobuf tallentaa **pakatun Hilbert-R-puun** ja käy sen läpi
taso kerrallaan; L0 laskee haettavat välit muistissa pidetystä katalogista.

Vertailu on tehty niin, että molemmat vastaavat **samaan kysymykseen**: mitkä
kohteet joiden rajauslaatikko leikkaa näkymää. L0:aan lisättiin tätä varten
`geo_bounding_box` (alla), jotta kyse ei ole keskipisteen ja laatikon vertailusta.

Toistettavissa: `tools/bench-fgb/` (README kertoo ajon).

## Mitä L0:aan lisättiin: `geo_bounding_box`

Sisäänotossa (`build({ bboxFields: ['bbox'] })`), kenttä `[minx, miny, maxx, maxy]`:

- **bbox-sarake dokumenttijärjestyksessä**, f64 × 4 = 32 B/dokumentti. Minkä
  tahansa dokumentin laatikon osoite on laskutoimitus, kuten bittikartan bitin.
- **granulekohtainen laatikko katalogissa**, f32 × 4 ulospäin pyöristettynä
  (yksi per 128 dokumenttia: 1 M dokumentilla 125 kB). Tämä on R-puun alin
  sisätaso pidettynä muistissa.

Haku: granulet joiden laatikko leikkaa näkymää valitaan katalogista ilman I/O:ta,
niiden bbox-sarakkeen viipaleet haetaan **yhdessä aallossa**, ja dokumentin
laatikko testataan tarkasti. Tulos on täsmälleen sama joukko kuin R-puun haulla.
Toimii L1-deltan kanssa (siirretty, lisätty ja poistettu kohde; `test/geo.test.js`).

```json
{ "geo_bounding_box": { "bbox": { "top_left": [x0, y1], "bottom_right": [x1, y0] } } }
```

## Asetelma

- **Aineisto:** synteettinen, ETRS-TM35FIN-laatikko. 1 000 000 pistettä, ja
  erikseen 1 000 000 polygonia (84 % pieniä 5–30 m, 15 % keskikokoisia
  50–500 m, 1 % suuria 2–30 km). 70 % kohteista on kaupunkirykelmissä.
- **Näkymät** tiheimmän rykelmän keskeltä: koko maa, 200 km, 20 km, 2 km, 200 m.
- **Verkko** simuloitu molemmille samoin: 30 ms per pyyntö, 100 MB/s per yhteys.
- **FlatGeobuf:** kirjaston oma `HttpReader` (lähdekoodi 4.6.1). Kirjaston JS-
  kirjoittaja ei tee indeksiä, joten R-puu (solmukoko 16) rakennettiin
  spesifikaation mukaan. Molempien formaattien jokaisen haun tulosmäärä
  tarkistettiin raa'alla läpikäynnillä.
- **Taulukoissa** kierrokset / pyynnöt / tavut / aika. L0 lämpimänä (katalogi
  muistissa); kylmänä L0 maksaa lisäksi 2 kierrosta ja katalogin (1,1–1,4 MB).
  FlatGeobuf on aina kylmä, koska lukija hakee headerin joka avauksella.

## Pisteet

Tiedostot: FlatGeobuf 178,7 MB (josta R-puu 42,7 MB), L0 128,2 MB.

| näkymä | osumia | FlatGeobuf | L0 `geo_bounding_box` |
|---|---|---|---|
| koko maa | 1 000 000 | 6 / 6 / 178,7 MB / 11,84 s | 2 / 9 / 76,9 MB / 1,84 s |
| 200 km | 290 704 | 11 / 23 / 55,8 MB / 3,11 s | 2 / 38 / 23,1 MB / 339 ms |
| 20 km | 96 984 | 8 / 16 / 20,4 MB / 1,35 s | 2 / 25 / 8,3 MB / 186 ms |
| 2 km | 1 424 | 5 / 5 / 633 kB / 183 ms | 2 / 4 / 217 kB / 64 ms |
| 200 m | 8 | 5 / 5 / 31 kB / 160 ms | 2 / 2 / 14 kB / 63 ms |

## Polygonit, pelkkä Hilbert-järjestys

Tiedostot: FlatGeobuf 306,7 MB, L0 125,4 MB. Viimeinen sarake on L0:n vanha
keskipistehaku (Hilbert-välit ilman bboxia): kuinka suuren osan oikeista
kohteista se löytää.

| näkymä | osumia | FlatGeobuf | L0 `geo_bounding_box` | keskipistehaun saanto |
|---|---|---|---|---|
| koko maa | 1 000 000 | 6 / 6 / 306,7 MB / 12,76 s | 2 / 9 / 98,7 MB / 2,52 s | 100 % |
| 200 km | 291 966 | 11 / 26 / 106,5 MB / 3,30 s | 2 / 52 / 33,6 MB / 1,35 s | 100 % |
| 20 km | 98 447 | 6 / 14 / 55,8 MB / 1,62 s | 2 / 65 / 16,7 MB / 187 ms | 99,5 % |
| 2 km | 2 310 | 7 / 25 / 47,5 MB / 567 ms | 2 / 170 / 11,9 MB / 84 ms | 62,9 % |
| 200 m | 745 | 7 / 28 / 45,4 MB / 433 ms | 2 / 111 / 14,9 MB / 116 ms | 1,1 % |

## Polygonit, kokoluokka ennen Hilbertiä

Sama aineisto, mutta järjestysavain on `(kokoluokka, hilbert)`, kokoluokat
< 100 m, < 2 km ja suuremmat. Sama muutos tehtiin molemmille formaateille.

| näkymä | osumia | FlatGeobuf | L0 `geo_bounding_box` |
|---|---|---|---|
| koko maa | 1 000 000 | 6 / 6 / 306,7 MB / 13,19 s | 2 / 9 / 98,7 MB / 2,31 s |
| 200 km | 291 966 | 12 / 36 / 96,1 MB / 3,07 s | 2 / 59 / 30,3 MB / 1,21 s |
| 20 km | 98 447 | 12 / 27 / 35,5 MB / 1,43 s | 2 / 38 / 11,2 MB / 853 ms |
| 2 km | 2 310 | 8 / 10 / 2,1 MB / 340 ms | 2 / 9 / 649 kB / 64 ms |
| 200 m | 745 | 8 / 10 / 871 kB / 279 ms | 2 / 8 / 277 kB / 62 ms |

## Havainnot

1. **Kierrokset.** L0 tekee lämpimänä aina 2 kierrosta (1 ilman tallennettuja
   kenttiä). FlatGeobuf tekee 5–12, ja määrä kasvaa puun syvyyden ja näkymän
   hajanaisuuden mukana: lukija (`streamSearch`) odottaa jokaisen solmualueen
   ennen seuraavaa. Kokoluokittelu *lisää* FlatGeobufin kierroksia (erilliset
   alipuut), vaikka se vähentää tavuja; L0:n kierroksiin se ei vaikuta.
2. **Indeksin koko on samaa luokkaa.** FlatGeobufin puu 40 B/kohde, L0:n
   bbox-sarake 32 B/kohde + 125 kB katalogissa. Tavuero tuloksissa (2–4×) tulee
   pääosin **muusta kuin indeksistä**: L0 koodaa geometrian 1 m ruudukkoon
   varintteina ja attribuutit skeemakoodattuina, FlatGeobuf f64-koordinaatteina
   ja FlatBuffersina. Se on reilu ero formaattien välillä, mutta ei
   indeksiratkaisun ansio.
3. **Isot ja pienet kohteet sekaisin ovat kummankin ongelma.** Suuret laatikot
   paisuttavat R-puun solmut ja L0:n granulelaatikot, joten 200 m näkymä luki
   45 MB (FlatGeobuf) ja 15 MB (L0). Kokoluokittelu putosi ne 0,87 MB:hen ja
   0,28 MB:hen. Tämä on yksi rivi sisäänotossa ja tärkein yksittäinen säätö
   kummallekin.
4. **Keskipistehaku ei kelpaa polygoneille.** Saanto putoaa 63 %:iin 2 km
   näkymässä ja 1 %:iin 200 m näkymässä. Tämä vahvistaa MML-raportin
   "Erityishavainnot 2":n ja perustelee `geo_bounding_box`in.
5. **Kylmäaloitus on FlatGeobufin vahvuus.** Sen header ja kolmen ylimmän
   tason esihaku ovat noin 13 kB; L0:n katalogi 1,1–1,4 MB. Yksittäiseen pieneen
   näkymään ilman istuntoa FlatGeobuf siirtää vähemmän tavuja.
6. **Mitä FlatGeobuf ei tee lainkaan:** attribuuttisuodatusta indeksissä,
   aggregointeja ilman kohteiden lukemista (L0: luokittaiset määrät 20 km
   näkymästä 1 kierros / 5,5 MB pisteillä) eikä päivityksiä.

## Rajoitukset

- Synteettinen aineisto. Suuret polygonit noudattavat samaa rykelmäjakaumaa
  kuin pienet, joten 200 m näkymässä 745 osumaa on kuormittava tapaus.
- Simuloitu verkko, ei oikeaa S3:a tai CDN:ää.
- Suurten näkymien aikaero johtuu suurelta osin siitä, että L0-lukija jakaa
  suuret välit rinnakkaisiksi paloiksi ja FlatGeobufin lukija ei. Se on
  lukijatoteutuksen ero, ei formaatin.
- FlatGeobufin R-puu on rakennettu tässä, koska JS-kirjoittaja ei tee indeksiä;
  GDAL:n kirjoittama puu voi poiketa järjestykseltään hieman.
