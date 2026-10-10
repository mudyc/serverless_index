# serverless_index

Muuttumaton, tavualuehaettava hakuindeksi objektitallennuksen päällä. Lukija on
puhdas funktio `(kysely, artefakti)` — ei palvelinta, ei istuntoa, ei prosessia
kyselyjen välissä.

Yksi kirjasto, kolme sisäänkäyntiä. Lukija on sama kaikissa; vain kuljetus
vaihtuu.

```js
import { Reader, Budget } from 'serverless-index';            // ydin, ajoympäristöriippumaton
import { build, FileTransport } from 'serverless-index/node'; // rakentaja + levy
import { open } from 'serverless-index/browser';              // HTTP Range + Buffer-shim
import { createHandler } from 'serverless-index/lambda';      // valmis API-käsittelijä
```

Erillisiä kirjastoja ei tarvita. Sama lukija ajaa Lambdassa ja selaimessa —
ja se on nimenomaan tarkoitus: toinen toteutus olisi toinen asia joka voi olla
eri mieltä. Ydin ei importtaa yhtään `node:`-moduulia (testattu,
`test/entrypoints.test.js`), joten se niputtuu selaimeen sellaisenaan.

## Nopea alku

```bash
node tools/gen-data.js 20000      # -> data/docs.json
node tools/build-index.js         # -> data/messages.l0  (4,6 MB, 20 000 doc)
node tools/serve.js . 8080 &

open http://127.0.0.1:8080/examples/browser/        # selain, ei palvelinta
node examples/lambda-api/local.js \
     http://127.0.0.1:8080/data/messages.l0         # sama käsittelijä kuin Lambdassa
```

## Budjetti — miksi tämä on oletuksena päällä

```js
const reader = await new Reader(transport, {
  budget: { requests: 2048, bytes: 256e6, rounds: 8, usd: 0.001, host: 's3' },
}).open();
```

Suunnittelija laskee jokaisen tavualueen **ennen kuin yhtään tavua haetaan**,
joten lasku on tiedossa etukäteen — ja siksi myös estettävissä. Yksi mitattu
MML-näkymä suunnitteli **193 088 tavualuetta**: sellaisenaan ajettuna
**0,0772 \$/näyttö eli 77,24 \$/tuhat näyttöä**, yhdistettynä **9 pyyntöä,
0,0036 \$/tuhat**. Suhde **21 454×**, ja sen ratkaisee yksi parametri.

Yli menevä kysely heittää `BudgetExceeded` ennen I/O:ta ja **nimeää kentän**:

```
query refused: requests 193,088 > limit 2,048
  this wave: 193,088 requests, 197.7 MB, $0.077235 on S3, same region
  ranges by field:
    bm:kaupallinenNimi           193,088
  [bm:kaupallinenNimi] dominates. A terms aggregation over a high-cardinality
  field asks for one range per value; reduce its size, or move the selector
  into the clustering key so the rows are contiguous.
```

`mode: 'warn'` mittaa estämättä. Lambda-adapteri palauttaa eston **400:na**
diagnoosin kanssa ja liittää `x-l0-requests` / `x-l0-bytes` / `x-l0-usd`
jokaiseen vastaukseen.

## Dokumentit

| | |
| --- | --- |
| [`docs/queries.md`](docs/queries.md) | **Mitä mikin kysely lukee.** Jokainen OpenSearch-muotoinen lauseke, sen käyttämä rakenne (bittikartta / lajiteltu sarake / harva rajataulu / trigrammit / tallennuslohkot) ja kustannuksen kasvu. Mitatut luvut. |
| [`docs/billing.md`](docs/billing.md) | **Mitä se maksaa.** Hinnoittelu isännittäin, pyynnöt vs. kierrokset, yhdistämissääntö ja sen korjaus, budjetin asettaminen. |
| [`docs/l0-tekninen-dokumentaatio.md`](docs/l0-tekninen-dokumentaatio.md) · [HTML](docs/l0-tekninen-dokumentaatio.html) | **Miten koko putki kulkee.** Kahdeksan vaihetta sisäänluvusta esitykseen, kukin oma piirretty kaavionsa: sisäänluku, rakennus, artefaktin asettelu, käännös ja suunnittelu, nouto, bittikartta-algebra, aggregoinnit, esitys. Yksitoista SVG-kaaviota ([`docs/kuvat/`](docs/kuvat)); HTML-versiossa ne ovat upotettuina. |
| [`docs/l0-index-format.md`](docs/l0-index-format.md) | **Miten indeksi toimii.** Formaatti, rakenteet, kyselykieli, kierrosbudjetti ja asettelu. |
| [`docs/idx_research.md`](docs/idx_research.md) | **Miksi se on tällainen.** 19 lukua: kirjoituskonsistenssimalli L0–L3, olemassa olevien formaattien analyysi, kyselyalgebra, rakenteenvalinta ja avoimet kysymykset. Liite B on mitattu kahta korpusta vastaan. 12 kaaviota. |
| [`docs/l0-mml-tekninen-raportti.md`](docs/l0-mml-tekninen-raportti.md) | **Miten se käyttäytyy oikealla aineistolla.** Indeksointiavain ja Hilbert-käyrä, aineiston muunnokset, esimerkkikyselyt. **Kuvat näkyvät vain PDF:ssä.** |

Lyhyin mahdollinen väite on `l0-index-format.md`:n alussa:

> Muuttumattomuus ei ole rajoite jonka tallennuskerros sanelee, vaan
> suunnittelun lähtökohta. Kyselyn hinta on **riippuvia kierroksia**, ei tavuja
> eikä suoritinaikaa — ja lämmin kysely maksaa tasan kaksi, riippumatta siitä
> montako predikaattia se kantaa.

Billing-dokumentti lisää tähän toisen: **kierros ei ole pyyntö**. Rinnakkainen
50 000 alueen aalto on yksi kierros ja 50 000 laskutettavaa pyyntöä. Latenssin
ja rahan optimointi eivät ole sama harjoitus.

## Rakenne

```
src/index.js          ydin — ei node:-importteja, niputtuu selaimeen
src/node.js           + rakentaja, FileTransport, LatencyTransport
src/browser.js        + HttpTransport, ChunkedHttpTransport, open(), Buffer-shim
src/cost.js           hinnasto, estimate(), Budget
src/transport/coalesce.js   yhdistämispolitiikka (ks. billing.md §3)
adapters/lambda.js    createHandler() — säiliökohtainen välimuisti, 400 estolle
examples/browser/     sivu joka kyselee suoraan artefaktia
examples/lambda-api/  SAM-malli + paikallinen ajo
tools/cost-report.js  mittaa jokaisen kyselymuodon; docs-taulukot syntyvät tästä
```

## Testit

```bash
node --test test/*.test.js      # 110
node tools/cost-report.js --docs 200000 --md
```

## Toteutukset

Nämä elävät omissa repoissaan.

| repo | korpus | artefakti |
| --- | --- | --- |
| `../L0_idx` | lukija, rakentaja, testit | — |
| `../mml-kartta` | MML:n maastokartta, 6 683 615 kohdetta | 883,7 MB |
| `../ajoneuvorekisteri` | Traficomin ajoneuvorekisteri, 5 288 425 ajoneuvoa | 581 MB |

Molemmat vastaavat mihin tahansa näkymään **2–4 kierroksessa ja 20–40 ms:ssä**.
Liitteen B luvut on mitattu näistä kahdesta.
