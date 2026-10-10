# Idea

> Hakuindeksi on palvelin siksi, että jonkun on pidettävä indeksi muistissa.
> Jos indeksi on osoitteellisia tavuja, osoittamisen voi tehdä selain — ja
> silloin palvelinta ei ole, ei myöskään silloin kun kukaan ei hae mitään.

Tämä dokumentti kertoo miksi kirjasto on olemassa. Muut dokumentit kertovat
miten se toimii.

## 1. Nykytila: lasku on lattia, ei funktio

Amazon OpenSearch Serverless -kokoelma (klassinen malli) ei skaalaudu nollaan.
Tuotantokokoonpanossa on vähimmäisvaatimus: 1 OCU indeksointiin ja 1 OCU
haulle, kumpikin kahdennettuna, hinta **0,24 $/OCU-tunti**. Se on noin
**350 $/kk ennen tallennusta** — ja se on sama summa kuukautena jona kukaan
ei tehnyt yhtään kyselyä.

Tämä on se kohta joka särähtää. Aineisto ei muutu, kyselyitä ei tule, ja
mittari käy. Kustannus ei ole käytön funktio vaan lattia, jonka maksaa
olemassaolosta. Sadalle pienelle aineistolle se on sata lattiaa.

Lähde: [AWS: OpenSearch Serverless entry cost](https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-opensearch-serverless-entry-cost-half-collection-types/),
[OpenSearch-hinnoittelun yhteenveto 2026](https://cubeapm.com/blog/aws-opensearch-pricing-review/).

## 2. NextGen myöntää ongelman — ja paljastaa toisen

AWS julkaisi **NextGen-kokoelmat yleisesti saataville 28.5.2026**. Niissä ei
ole OCU-vähimmäismäärää: indeksointi- ja haku-OCU:t **skaalautuvat nollaan
kymmenen minuutin käyttämättömyyden jälkeen**, ja jouten oleva kokoelma
maksaa vain tallennuksesta.

Hinta siis korjattiin. Mutta korjauksella on hinta: kun kapasiteetti on
vapautettu, **ensimmäinen pyyntö odottaa 10–30 sekuntia** kapasiteetin
palautumista. Pyynnöt jonotetaan, ei pudoteta, ja kiertotie on lähettää
lämmittelykysely ennen oikeaa liikennettä.

Lähde: [AWS Big Data Blog: next generation of Amazon OpenSearch Serverless](https://aws.amazon.com/blogs/big-data/the-next-generation-of-amazon-opensearch-serverless-built-from-the-ground-up-for-agents/),
[Scale-to-zero cost with Lambda and OpenSearch Serverless NextGen](https://builder.aws.com/content/2uSF0s4ijx8iH4o2uVJgXxvXpGS/scale-to-zero-cost-with-lambda-and-opensearch-serverless-nextgen).

**Tässä on koko argumentti yhdessä virkkeessä.** Jos hyväksyt 10–30 sekunnin
kylmäkäynnistyksen, olet jo hyväksynyt että kyselyjen välissä ei ole elävää
prosessia. Kylmäkäynnistys on se aika joka menee prosessin pystyttämiseen
uudelleen. Kysymys kuuluu silloin: miksi sellainen prosessi ylipäätään
tarvitaan?

Lämmittelykysely on sama myönnytys toisin päin. Se on maksu siitä, että
palvelimella on tila, joka pitää saattaa olemassaoloon ennen kuin sille voi
puhua.

## 3. Mitä muuttumaton artefakti tekee toisin

Lukija on puhdas funktio `(kysely, artefakti)`. Kyselyjen välissä ei ole
tilaa, koska ei ole mitään jonka olisi määrä säilyä. Ei ole prosessia, siksi
ei ole kylmäkäynnistystä — ensimmäinen kysely maksaa saman kuin tuhannes.

|  | OpenSearch Serverless (klassinen) | OpenSearch Serverless NextGen | Muuttumaton artefakti |
| --- | --- | --- | --- |
| lattia käyttämättömänä | ~350 $/kk | tallennus | tallennus |
| kylmäkäynnistys | ei (ei sammu) | **10–30 s** | **ei ole** |
| ensimmäinen kysely | lämmin | 10–30 s | **2 kierrosta, 63 ms** (30 ms RTT) |
| mistä maksetaan | varatusta ajasta | varatusta ajasta + tallennus | pyynnöistä ja tavuista |
| kirjoitukset | heti | heti | uudelleenrakennus (ks. §6) |
| käyttöoikeudet riveittäin | kyllä | kyllä | **ei** (ks. §6) |

63 ms on mitattu, ei arvioitu: `npm run latency` simuloi 30 ms:n kierrosajan
ja ajaa samat kyselyt. Luvut ovat `l0-index-format.md`:n "At 30 ms per round
trip" -taulukossa.

Lattia ei ole nolla vaan tallennus, ja tallennus on halpaa sillä tavalla joka
muuttaa laskennan luonnetta: §4:n 22,8 MB:n artefakti maksaa S3:ssa
**0,00052 $/kk**.

## 4. Verkkokauppa — mitattu esimerkki

Verkkokaupan tuoteluettelo on juuri se aineisto jolle tämä sopii: se on
suurehko mutta ei valtava, sitä selataan paljon, se muuttuu harvoin, ja
melkein kaikki mitä kävijä tekee on suodatusta ja lajittelua.

Rakennettu demokorpuksesta, **100 000 tuotetta**, samoilla kenttätyypeillä
joita oikea luettelo käyttäisi (totuusarvoja, lukuja, avainsana, vapaa teksti):

```
artefakti  22,8 MB  (228 B/doc), rakennus 0,7 s
katalogi   113 kB   (residentti, haetaan kerran istunnossa)
sektioita  39
```

Istunto, jossa kävijä selaa, suodattaa kolmella fasetilla, rajaa hinnan,
hakee tekstillä ja sivuttaa:

| kysely | osumia | kierroksia | hakuja | tavuja |
|---|---|---|---|---|
| tuotelistaus (`match_all`, 25 kpl) | 100 000 | **1** | 1 | 9 kB |
| yksi fasetti (`term`) | 44 989 | **2** | 2 | 22 kB |
| kolme fasettia yhdessä | 15 411 | **2** | 5 | 865 kB |
| hintahaarukka (`range`) | 40 662 | **2** | 3 | 488 kB |
| vapaa tekstihaku (`*lasku*`) | 12 586 | **2** | 6 | 2 901 kB |
| fasettilaskurit (`terms`-aggregointi) | 100 000 | **1** | 12 | 146 kB |
| sivu 40 (`from=1000`) | 100 000 | **1** | 1 | 19 kB |

Koko istunto: **30 hakua, 4,56 MB**. S3:n hinnoilla (0,40 $/miljoona GET,
0,09 $/GB ulos) se on **0,42 $ tuhatta istuntoa kohti**.

Siitä seuraa yksi luku, joka kannattaa pitää mielessä: klassisen kokoelman
350 $/kk vastaa **noin 830 000 istuntoa kuukaudessa**. Sen alle jäävällä
kaupalla lattia on kallein yksittäinen rivi.

Huomaa mikä hallitsee: **tavut, eivät pyynnöt.** 30 pyyntöä maksaa
0,000012 $, 4,56 MB maksaa 0,00041 $. Selainkäytössä tavut ovat sekä lasku
että käyttäjän odotus, ja siksi budjetti rajaa oletuksena molempia — ja siksi
tavualueiden yhdistäminen on ehdollista eikä automaattista (`billing.md` §3).
Vapaa tekstihaku on tässä kallein kysely kuudella haulla ja 2,9 MB:lla; jos
kauppa tekee sen joka näppäinpainalluksella, se on ensimmäinen asia jota
kannattaa rajoittaa.

Muukin kuin kauppa käy. Aineisto, jolla on paljon lukijoita ja harvoja
kirjoituksia, on sama muoto riippumatta siitä onko se tuoteluettelo,
ajoneuvorekisteri, maastokartta vai 118 vuotta säähavaintoja — ne kolme
viimeistä ovat tämän kirjaston toteutuksia ja elävät GitHub Pagesissa ilman
yhtään palvelinta.

## 5. Miksi selain eikä Lambda

Molemmat toimivat, sama lukija. Mutta selain on se vaihtoehto joka poistaa
kerroksen kokonaan:

- **Ei API:a suunniteltavaksi.** Kyselykieli on jo olemassa, ja se ajetaan
  siellä missä vastaus näytetään.
- **Ei laskentakerrosta rajoitettavaksi.** Ei ole prosessia joka voisi
  ylikuormittua — vain objektitallennus, joka skaalautuu sinun puolestasi.
- **Ei kahta toteutusta.** Sama koodi ajaa Lambdassa ja selaimessa. Toinen
  toteutus olisi toinen asia, joka voi olla eri mieltä.

Lambda-polku on silti olemassa, ja se on oikea valinta kahdessa tapauksessa:
kun tavut ovat kalliita käyttäjälle mutta halpoja palvelimelle (Lambdassa
saman alueen S3-liikenne on ilmaista), ja kun artefaktia ei haluta antaa
kävijälle kokonaan.

## 6. Mihin tämä ei taivu

Nämä eivät ole puutteita joita ollaan korjaamassa, vaan mallin hinta.

**Kirjoitukset.** L0 olettaa ettei niitä ole. Tuote- ja hintamuutokset
hoituvat uudelleenrakennuksella: 100 000 dokumenttia rakentui **0,7
sekunnissa**, joten tunnin välein tai yöllä se on merkityksetön kustannus.
Varastosaldo, joka muuttuu minuuteissa, ei kuulu artefaktiin — se on erillinen
kutsu kassavaiheessa. `idx_research.md` §7 kuvaa L1:n (manifesti, pienet
lisätyt artefaktit, tombstonet), mutta **sitä ei ole toteutettu.**

**Käyttöoikeudet riveittäin.** Artefakti on julkisia tavuja. Kaikki mitä
selain voi kysyä, kävijä voi myös ladata kokonaan. Rivikohtaista suodatusta
ei ole eikä voi olla: jos rivi on salainen, se ei kuulu artefaktiin.

**Relevanssi.** Tämä suodattaa ja lajittelee; se ei pisteytä.
`_score` on `null`. Jos haun arvo on siinä että paras osuma on ensimmäisenä
eikä siinä että oikeat osumat löytyvät, tämä on väärä työkalu.

**Aggregoinnit.** Ylätasolla vain `terms` ja `histogram`; numeeriset
tunnusluvut vain alikyselyinä. `terms` `terms`-aggregoinnin sisällä ei ole
tuettu. Rajat ovat `queries.md`:ssä.

**Koko.** Selaimen puolella artefaktin koko on käyttäjän kaistaa. Kolme
toteutusta ovat 581–884 MB ja toimivat, koska kysely lukee niistä murto-osan
— mutta se on suunnittelua, ei automatiikkaa, ja budjetti on olemassa koska
väärin muotoiltu kysely lukee enemmän.

## 7. Mitä tämä vaatisi oikeassa kaupassa

Rehellinen lista siitä mitä ei ole vielä olemassa:

1. **L1** — kirjoitukset manifestina ja pieninä lisättyinä artefakteina
   (suunniteltu, §7, ei toteutettu).
2. **Rakennusputki** — tuotetietokannasta artefaktiksi ja CDN:ään,
   versioituna niin ettei selain sekoita sukupolvia. Versiointimekanismi on
   olemassa (`chunked-http.js`, `?v=`), putki ei.
3. **Relevanssi** jos haku on myyntikanava eikä navigointi.

Kohdat 1 ja 3 ovat oikeaa työtä. Kohta 2 on päivä.

---

Lyhyin muoto: **kylmäkäynnistys on hinta siitä, että palautetaan jotain jota
ei tarvitsisi olla olemassa.** Jos aineisto ei muutu kyselyjen välissä,
indeksi voi olla tiedosto — ja tiedostolla ei ole käynnistystä, lämmintä
eikä kylmää.
