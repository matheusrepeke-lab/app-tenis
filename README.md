# Corte de Tênis

Site que recebe o vídeo de um jogo de tênis e devolve:

- **o vídeo cortado**, só com os rallies (o tempo morto entre os pontos sai);
- **a velocidade de cada batida** no canto superior direito, com o nome de quem bateu;
- **um vídeo leve**: 720p, cerca de 15 MB por minuto (um jogo de 50 min de vários GB vira algumas centenas de MB);
- uma planilha (CSV) com todas as batidas e velocidades.

## Por que não tem limite de tamanho

O vídeo **não é enviado para lugar nenhum**. O site roda no navegador e lê o arquivo direto do
computador ou celular. Por isso:

- não existe o limite de 400 MB;
- não se perde tempo subindo um arquivo de 5 a 10 GB (só o envio levaria mais de 5 minutos);
- o vídeo não sai do seu aparelho.

## Como usar

1. Abra o site no **Chrome ou Edge no computador** (mais rápido) ou no **Safari no iPhone**.
2. Toque em **Escolher vídeo** e selecione o arquivo do jogo (MOV ou MP4).
3. Toque em **Cortar vídeo**.
4. No fim, baixe o vídeo, compartilhe ou baixe a planilha das batidas.

Ajustes úteis:

| Ajuste | Para quê |
|---|---|
| Tamanho do vídeo final | 540p é o mais leve; 720p é o recomendado |
| Qualidade | "Leve" deixa o arquivo menor |
| Velocidade mostrada | média do trajeto (medida) ou estimativa de saída da raquete (×1,35) |
| Sensibilidade | aumente se faltarem batidas; diminua se cortar no lugar errado |
| Nomes dos jogadores | aparecem na placa de velocidade |
| Distância entre os jogadores | padrão 25 m (os dois um pouco atrás da linha de base) |

## Como funciona

1. **Áudio (≈10% do tempo):** o som é filtrado na faixa do "toc" da bola (1 a 6 kHz) e cada
   pico forte e rápido vira uma batida. A batida mais alta é de quem está perto da câmera.
2. **Rallies:** batidas com menos de 3 s entre si formam um rally. Ficam os rallies com
   pelo menos 2 batidas, com 1 s de margem antes e 1,5 s depois.
3. **Velocidade:** tempo entre a batida de um jogador e a do outro, descontando o atraso do
   som do jogador do fundo (25 m ÷ 343 m/s ≈ 0,07 s). Velocidade = distância ÷ tempo.
   É a velocidade **média** do trajeto (com o quique); a saída da raquete é mais alta.
   Margem de erro de 10 a 15%.
4. **Vídeo:** os trechos são decodificados, reduzidos para 720p, recebem a placa e são
   gravados em H.264 usando o hardware de vídeo do aparelho (WebCodecs). O áudio é copiado
   sem recomprimir. Em computadores com vários núcleos o jogo é dividido em até 4 partes
   processadas ao mesmo tempo e juntadas no fim, sem recomprimir.

### Velocidade de processamento

| Situação | Medido / esperado |
|---|---|
| Servidor de teste sem placa de vídeo, 4 núcleos (2 partes) | jogo sintético de 12 min → 8min31s em **2min41s** (~95 quadros/s) |
| Computador comum com Chrome (decodificação e gravação em hardware) | várias centenas de quadros/s |

Um jogo de 50 min que vira ~35 min tem cerca de 63 mil quadros a 30 fps. A 250 quadros/s
são ~4 min. Vídeos em 60 fps são gravados em 30 fps (só metade dos quadros é processada),
a não ser que você marque "Manter 60 fps".

## Dicas de gravação

- Câmera **fixa** (tripé ou alambrado), atrás da linha de base.
- **1080p a 30 ou 60 fps** é suficiente; 4K deixa o arquivo enorme e o processamento mais lento.
- Evite música alta perto da quadra.

## Publicar o site (GitHub Pages)

O site é só HTML/JS estático, sem servidor.

1. No GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Junte este branch no `main`. O workflow `.github/workflows/pages.yml` publica o site.
3. O endereço aparece em Settings → Pages (algo como `https://<usuario>.github.io/app-tenis/`).

Para testar no computador sem publicar: `python3 -m http.server 8000` na pasta do projeto e
abrir `http://localhost:8000`.

## Testes

```bash
node --test test/*.test.mjs          # análise de áudio com batidas sintéticas
python3 -m http.server 8766 &         # serve o site
node test/e2e.cjs video.mov pasta/    # processa um vídeo de ponta a ponta no Chromium (Playwright)
```

## Estrutura

```
index.html            tela
css/style.css         visual (claro e escuro)
js/app.js             controle da tela e das partes em paralelo
js/worker.js          leitura, análise, gravação e junção do vídeo (roda em segundo plano)
js/analysis.js        detecção das batidas, rallies e velocidade (código puro, testado)
vendor/               Mediabunny 1.65.2 (leitura/gravação de MP4/MOV, licença MPL-2.0)
```
