# L0-indeksin tekninen dokumentaatio

2026-09-28 · Matti Katila

L0 on muuttumaton indeksiformaatti, jota luetaan HTTP-tavualueina ilman hakupalvelinta: 5 288 425 ajoneuvon 2,37 GB:n artefakti vastaa haku- ja aggregointikyselyihin yhdellä edestakaisella kierroksella, tyypillisesti 15–40 ms. Tämä dokumentti kuvaa ensin kokonaisuuden ja sitten jokaisen vaiheen omassa luvussaan.


## Yleiskuvaus

L0 vastaa haku- ja aggregointikyselyihin ilman hakupalvelinta. Koko indeksi on yksi muuttumaton tiedosto, ja lukija noutaa siitä vain ne tavualueet joita kysely tarvitsee. Ajoneuvorekisterin artefakti on 2,37 GB ja sisältää 5 288 425 dokumenttia, mutta tyypillinen kysely siirtää muutamia megatavuja ja valmistuu 15–40 ms:ssa.

![koko putki · rakennusaika ja lukuaika](kuvat/00-koko-putki.svg)

*koko putki · rakennusaika ja lukuaika*

Artefakti on saranakohta: kaikki sen yläpuolella tapahtuu kerran, kaikki alapuolella jokaisella kyselyllä.

Muuttumattomuus on koko suunnittelun perusta. Kun sektio ei voi muuttua, noudettu tavualue ei voi vanhentua, joten sen voi välimuistittaa pysyvästi ja tarjoilla mistä tahansa staattisesta palvelusta. Hinta on se, ettei artefaktia voi päivittää osittain: muutos tarkoittaa uutta versiota.


## Vaihe 1 — Sisäänluku

Sisäänluku on ainoa kohta jossa dataa normalisoidaan; lukija ei normalisoi mitään. 961 MB:n CSV luetaan virtana, ja 5 288 425 riviä muuttuu dokumenteiksi 11,6 sekunnissa.

![sisäänluku · 61 saraketta → 20 kenttää viidessä luokassa](kuvat/01-sisaanluku.svg)

*sisäänluku · 61 saraketta → 20 kenttää viidessä luokassa*

Päivämäärät muuttuvat tässä järjestettäviksi kokonaisluvuiksi muotoa YYYYMMDD, luvut jäsennetään, ja koodit jäävät koodeiksi. Rivi jolla ei ole käyttöönottopäivää pudotetaan, koska klusterointiavaimen on oltava olemassa.

Johdetut sarakkeet lasketaan tässä, ei kyselyaikana. Teho-painosuhde on kahden sarakkeen osamäärä, eikä sitä voi koota jälkikäteen ämpärikohtaisista summista, koska kahden keskiarvon osamäärä ei ole osamäärien keskiarvo. Maakunta johdetaan kunnasta, koska yksi tiheä bittikartta on halvempi lukea kuin OR noin seitsemäntoista harvan yli.


## Vaihe 2 — Rakennus

Rakennus tekee kaksi päätöstä joita ei enää voi muuttaa: missä järjestyksessä dokumentit ovat ja mikä rakenne kullekin kentälle tehdään.

![rakennus · neljä sektiotyyppiä kenttätyypin mukaan](kuvat/02-rakennus.svg)

*rakennus · neljä sektiotyyppiä kenttätyypin mukaan*

Järjestys on koko formaatin perusta. Dokumentit lajitellaan klusterointiavaimella, tässä käyttöönottopäivällä, ja dokumentin tunniste on sen sijainti tuossa järjestyksessä. Siksi aikaväliehto on yhtenäinen bittialue eikä hajallaan oleva joukko, ja siksi vuosihistogrammi on pelkkä jako granuloihin.

Kenttätyyppiä ei ilmoiteta vaan se päätellään datasta. Merkkijonokenttä jolla on enintään 200 000 eri arvoa saa bittikartan jokaista arvoa kohti; sitä runsaampi saa trigrammipostitukset. Numeerinen kenttä kirjoitetaan arvojärjestykseen lajiteltuna sarakkeena, jonka rinnalla kulkevat dokumenttitunnisteet ja harva indeksi joka 8192. sijainnista.

Rakennus kesti 5 288 425 dokumentille 4 h 41 min yhdellä koneella, sisäänluku siitä 11,6 sekuntia. Se on kertakustannus: yksikään kysely ei tee tätä työtä uudelleen.


## Vaihe 3 — Artefaktin rakenne

Artefakti on tavallinen tiedosto, jonka viimeiset 16 tavua kertovat mistä kaikki muu löytyy.

![artefaktin asettelu · footer viittaa taaksepäin katalogiin](kuvat/03-artefaktin-asettelu.svg)

*artefaktin asettelu · footer viittaa taaksepäin katalogiin*

Footer on lopussa, koska kirjoittaja tietää sektioiden siirtymät vasta kun ne on kirjoitettu, eikä virtana kirjoittaminen salli paluuta alkuun. Lukija puolestaan löytää sen ilman ennakkotietoa: yksi häntälukupyyntö riittää, olipa tiedosto minkä kokoinen tahansa.

| Osa | Koko | Osuus |
| --- | --- | --- |
| Tallennetut kentät | 1 832 MB | 77,3 % |
| Sarakkeet | 412 MB | 17,4 % |
| Bittikartat | 108 MB | 4,6 % |
| Katalogi | 18,7 MB | 0,8 % |
| Footer | 16 tavua | — |

Varsinainen indeksi on pieni. Bittikartat ja sarakkeet ovat yhteensä 520 MB eli 22 % tiedostosta; loput ovat tallennettuja kenttiä, joita tarvitaan vain kun tulosrivit näytetään. Aggregointikysely ei kosketa niitä lainkaan, mikä on syy siihen että koko tämän dokumentaation esimerkkikyselyt siirtävät megatavuja eivätkä gigatavuja.


## Vaihe 4 — Kyselyn käännös ja suunnittelu

Kysely muuttuu tavualueiden luetteloksi ennen kuin yhtään pyyntöä on tehty. Käännös ja suunnittelu lukevat katalogia, eivät artefaktia.

![käännös ja suunnittelu · kysely → puu → tavualueet](kuvat/04-kaannos-ja-suunnittelu.svg)

*käännös ja suunnittelu · kysely → puu → tavualueet*

Kääntäjä hyväksyy Elasticsearchista tutun osajoukon — bool, term, terms, range, exists, wildcard — ja hylkää tuntemattoman kyselytyypin äänekkäästi. Hiljainen hylkääminen tuottaisi väärän tuloksen ilman virheilmoitusta, mikä on hakujärjestelmän pahin vikatila.

Lukualueen suunnittelu on kohta jossa harva indeksi maksaa itsensä takaisin. Numeeriselle väliehdolle etsitään katalogin harvasta indeksistä ne granulat jotka voivat sisältää rajat, ja vain ne noudetaan; rajan ylittävät yksittäiset arvot karsitaan muistissa. Granulan rajaus on tarkoituksella yhtä granulaa liian avara kumpaankin suuntaan, koska saman arvon toistuminen granularajan yli katkaisisi muuten tulosjoukon.


## Vaihe 5 — Nouto

Kysely tekee yhden noutoaallon: kaikki tarvittavat tavualueet lähtevät samaan aikaan, eikä mikään niistä riipu toisen sisällöstä.

![nouto · avaus kaksi kierrosta, kysely yksi](kuvat/05-nouto.svg)

*nouto · avaus kaksi kierrosta, kysely yksi*

Riippumattomuus on suunnittelun tavoite, ei sattuma. Jos jokin alue voitaisiin määrittää vasta toisen sisällön perusteella, kysely maksaisi kaksi kierrosta yhden sijaan. Siksi myös aggregointien ja toissijaisen lajittelun tarvitsemat sektiot arvioidaan katalogin tilastoista etukäteen ja ajetaan samassa aallossa: ylimääräinen noudettu tavu on halvempi kuin ylimääräinen kierros.

Yhdistämissääntö jouduttiin korjaamaan mittauksen perusteella. Alkuperäinen päättely oli, että vierekkäiset alueet kannattaa yhdistää kun aukko on pienempi kuin viive kertaa kaistanleveys — S3:lla noin 3 MB — mutta se oletti vaihtoehdoksi toisen kierroksen. Rinnakkaisessa aallossa vaihtoehto on yksi lisäalue ilman lisäviivettä, joten yhdistäminen vain lisää tavuja. Nykyinen sääntö yhdistää vain päästäkseen rinnakkaisuusbudjetin alle tai mitättömän pienen, 32 kB:n aukon yli.

Suuri alue pilkotaan päinvastaiseen suuntaan. Yhden yhteyden kaistanleveys rajoittaa yhtä pyyntöä, mutta oliotallennus skaalautuu monen yhteyden yli, joten yli 4 MB:n alue jaetaan enintään 32 rinnakkaiseen palaan — ilman lisäkierrosta, koska palat ovat toisistaan riippumattomia.

Sektiot ovat muuttumattomia, joten välimuistissa oleva sektio ei voi vanhentua. Tämä tekee fasettien uudelleenpiirrosta ilmaista: kun 320 kunnan bittikartat on kerran noudettu, jokainen suodattimen muutos on pelkkää laskentaa muistissa ilman verkkoa.


## Vaihe 6 — Evaluointi ja sivutus

Jokainen operaattori tuottaa bittikartan, ja ne yhdistetään AND-, OR-, XOR- ja ANDNOT-operaatioilla. Tulosjoukon koko on popcount: tarkka luku, ei arvio.

![bittikartta-algebra · 24 dokumenttia, kaksi ehtoa, yksi sivu](kuvat/06-bittikartta-algebra.svg)

*bittikartta-algebra · 24 dokumenttia, kaksi ehtoa, yksi sivu*

Sivutus on k:nnen ykkösbitin etsintä. Koska dokumentin tunniste on sen sijainti klusterointijärjestyksessä, pyydetty sivu kääntyy suoraan sijaintiluetteloksi, ja tallennetuista kentistä noudetaan täsmälleen ne rivit eikä riviäkään enempää.

Tämä on myös syy siihen, ettei tulosjoukon kokoa tarvitse rajoittaa. OpenSearchissa syvä sivutus on kallista, koska se edellyttää tulosten lajittelua ja siirtämistä solmujen välillä, ja siksi oletusraja on 10 000 osumaa. Bittikartta miljoonalle osumalle on 125 kB, ja miljoonannen osuman löytäminen on sama operaatio kuin tuhannennen.

Bittikartat koodataan kahdella tavalla sen mukaan kumpi on pienempi: tiheänä bittijonona tai järjestettynä tunnisteluettelona. Valinta tehdään rakennusaikana sektiokohtaisesti, joten harvinainen arvo ei maksa tiheän kartan hintaa.


## Vaihe 7 — Aggregoinnit

Aggregointi ei ole erillinen kyselyvaihe vaan sama aalto. Ämpärin arvo on osumakartan ja arvokartan leikkauksen popcount, ja arvosektiot ovat katalogista osoitettavissa, joten fasetoitu kysely maksaa yhä yhden kierroksen.

![aggregoinnit · terms ja histogram samassa aallossa](kuvat/07-aggregoinnit.svg)

*aggregoinnit · terms ja histogram samassa aallossa*

Klusterointiavaimen histogrammi on erikoistapaus, jossa ämpäri on granulaväli. Sitä ei tarvitse laskea bittikartan yli lainkaan: riittää laskea ykkösbitit tietyltä väliltä. Numeeriset alaggregoinnit — avg, min, max, sum, stats — täytetään yhdellä pyyhkäisyllä sarakkeen yli niin, että kaikki ämpärit täyttyvät samalla kertaa.

Mitattuna ajoneuvorekisterillä: käyttövoima vuosittain 32 ms ja 2,1 MB, hybridiluokka vuosittain 16 ms ja 1,3 MB, värit vuosittain 21 ms ja 5,4 MB — kukin yksi kierros.

Tähän osui myös toteutuksen pahin virhe. Terms-aggregointi materialisoi aluksi tiheän bittikartan jokaista arvoa kohti, ja koska yksi kartta on 5,3 miljoonalle dokumentille 662 kB, 96 521 kaupallista nimeä olisi vaatinut 64 GB muistia. Korjaus oli laskea tunnisteluettelot suoraan, materialisoimatta niitä kartaksi.


## Vaihe 8 — Esitys

Sivu on staattinen: se lataa yhden JSON-tiedoston ja kaksi rajageometriaa, eikä sen takana ole palvelinta.

![esitys · toteutettu esilaskenta ja mahdollinen elävä kysely](kuvat/08-esitys.svg)

*esitys · toteutettu esilaskenta ja mahdollinen elävä kysely*

Esilaskenta ei ole formaatin rajoitus vaan kuljetuskerroksen. Nykyinen tiedostokuljetus lukee paikallista tiedostoa ja toimii vain Nodessa, mutta sama suunnittelu ja evaluointi toimisivat selaimessa sellaisenaan HTTP Range -pyyntöjen päällä, koska lukija ei tarvitse muuta kuin tavualueita. Työtä jää kuljetusluokka, artefaktin paloittelu alle 100 MiB:n tiedostoihin ja tallennettujen kenttien karsiminen.

Kustannukset näytetään sivulla, koska indeksin pointti on kierrosmäärä eikä kuvaaja. Viidentoista visualisoinnin aggregoinnit maksavat yhteensä 4,2 s, ja siitä 3,5 s on yhdessä kyselyssä: mittarilukemat merkeittäin, joka pyyhkäisee 2 941 606 arvon sarakkeen. Kaikki muut ovat 15–245 ms.

Järjestelmässä on 90 testiä, joista osa vertaa jokaisen kyselytyypin tulosta suoraviivaiseen viitetoteutukseen samalla aineistolla. Se on ainoa tapa havaita hiljainen väärä tulos, joka on tämän arkkitehtuurin vaarallisin vikatila.


---

Kaaviot on renderöity lähteestä; alkuperäinen elävä dokumentti on [https://claude.ai/artifact/NEASAr79qcJDTkywSdpfaU](https://claude.ai/artifact/NEASAr79qcJDTkywSdpfaU).
