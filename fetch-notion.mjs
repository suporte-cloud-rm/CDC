import fs from "node:fs";
import https from "node:https";
import path from "node:path";

// Carrega variaveis do arquivo .env se ele existir localmente
if (fs.existsSync(".env")) {
  const envConfig = fs.readFileSync(".env", "utf8");
  envConfig.split("\n").forEach(line => {
    const [key, value] = line.split("=");
    if (key && value) {
      process.env[key.trim()] = value.trim();
    }
  });
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = "70cbd5429ec38371a96d81e62c92929d";

// Cria pasta assets local para armazenar as imagens permanentemente
const ASSETS_DIR = "./assets";
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// Função de pausa para evitar Rate Limit
const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function notionRequest(endpoint, retries = 5) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.notion.com',
          port: 443,
          path: `/v1${endpoint}`,
          method: 'GET',
          rejectUnauthorized: false,
          headers: {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'User-Agent': 'NodeJS-Script'
          }
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = data ? JSON.parse(data) : {};
              // Se o Notion bloquear por excesso de requisições
              if (res.statusCode === 429) {
                reject({ status: 429, message: "Rate limit excedido" });
              } else if (res.statusCode >= 400) {
                reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', (e) => reject(e));
        req.end();
      });
    } catch (e) {
      // Tenta novamente se for bloqueio de limite do Notion
      if (e.status === 429 && i < retries) {
        console.log(`[Rate Limit Notion] Aguardando para tentar novamente (${i + 1}/${retries})...`);
        await delay(1500 * (i + 1)); // Aumenta o tempo de espera a cada tentativa falha
        continue;
      }
      throw e; 
    }
  }
}

function downloadImage(url, filename) {
  return new Promise((resolve) => {
    const filePath = path.join(ASSETS_DIR, filename);
    
    if (fs.existsSync(filePath)) {
      return resolve(`./assets/${filename}`);
    }

    const file = fs.createWriteStream(filePath);
    https.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(`./assets/${filename}`));
        });
      } else {
        fs.unlink(filePath, () => resolve(url)); 
      }
    }).on('error', () => {
      fs.unlink(filePath, () => resolve(url));
    });
  });
}

function extractIdsFromRichText(richTextArray) {
  const ids = [];
  if (!Array.isArray(richTextArray)) return ids;
  for (const item of richTextArray) {
    if (item.type === "mention" && item.mention && item.mention.type === "page" && item.mention.page) {
      ids.push(item.mention.page.id);
    }
  }
  return ids;
}

async function getBlockContent(blockId) {
  let text = "";
  const subPageIds = [];

  try {
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const url = `/blocks/${blockId}/children?page_size=100` + (startCursor ? `&start_cursor=${startCursor}` : '');
      const data = await notionRequest(url);

      for (const block of data.results) {
        if (block.type === "child_page") {
          subPageIds.push(block.id);
          continue;
        }

        if (block.type === "link_to_page" && block.link_to_page) {
          const ltp = block.link_to_page;
          if (ltp.type === "page_id" && ltp.page_id) subPageIds.push(ltp.page_id);
          continue;
        }

        if (block.type === "image" && block.image) {
          const imgUrl = block.image.type === "file" ? block.image.file.url : block.image.external.url;
          if (imgUrl) {
            const imageName = `img_${block.id.replaceAll("-", "")}.png`;
            const localPath = await downloadImage(imgUrl, imageName);
            text += `\n![Imagem](${localPath})\n`;
          }
          continue;
        }

        const btype = block.type;
        
        // Garante que os textos dentro de Tabelas sejam lidos pelo OCR
        if (btype === "table_row" && block.table_row && block.table_row.cells) {
          for (const cell of block.table_row.cells) {
            text += " " + cell.map(t => t.plain_text).join("");
            subPageIds.push(...extractIdsFromRichText(cell));
          }
        }

        if (block[btype]) {
          if (block[btype].rich_text && Array.isArray(block[btype].rich_text)) {
            const blockContent = block[btype].rich_text.map(t => {
              if (t.href) {
                return `[${t.plain_text}](${t.href})`;
              }
              return t.plain_text;
            }).join("");

            text += "\n" + blockContent;
            subPageIds.push(...extractIdsFromRichText(block[btype].rich_text));
          }

          if (block[btype].title && Array.isArray(block[btype].title)) {
            text += "\n" + block[btype].title.map(t => t.plain_text).join("");
            subPageIds.push(...extractIdsFromRichText(block[btype].title));
          }
        }

        if (block.has_children) {
          const inner = await getBlockContent(block.id);
          text += "\n" + inner.text;
          subPageIds.push(...inner.subPageIds);
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;
      
      // Pequena pausa para evitar esgotar a API ao virar a página
      if (hasMore) await delay(200);
    }
  } catch (e) {
    console.error(`[Aviso] Falha ao processar filhos do bloco ${blockId}:`, e.message);
  }

  return { text, subPageIds };
}

const visitedPages = new Set();

async function scanPageRecursively(pageId, parentPath = []) {
  const cleanId = pageId.replaceAll("-", "");
  if (visitedPages.has(cleanId)) return [];
  visitedPages.add(cleanId);

  const docs = [];
  try {
    const page = await notionRequest(`/pages/${pageId}`);
    let title = "Sem título";

    if (page.properties) {
      const titleProp = Object.values(page.properties).find(p => p.id === "title" || p.type === "title");
      if (titleProp && titleProp.title && titleProp.title.length > 0) {
        title = titleProp.title.map(t => t.plain_text).join("");
      }
    }

    const currentPath = [...parentPath, title];
    const pathString = currentPath.join(" > ");
    console.log(`Indexando: ${pathString}`);

    const { text, subPageIds } = await getBlockContent(pageId);

    docs.push({
      id: page.id,
      title: title,
      path: pathString,
      url: page.url || null,
      text: (title + "\n\n" + text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    });

    for (const childId of subPageIds) {
      const childDocs = await scanPageRecursively(childId, currentPath);
      docs.push(...childDocs);
    }
  } catch (err) {
    console.error(`[ERRO CRÍTICO] Falha ao escanear página ${pageId} (${parentPath.join(" > ")}):`, err.message);
  }

  return docs;
}

async function main() {
  console.log("Iniciando varredura e download de imagens (Pode demorar alguns minutos)...");
  const docs = await scanPageRecursively(PAGE_ID);

  const payload = {
    generatedAt: new Date().toISOString(),
    count: docs.length,
    docs
  };

  const jsonContent = JSON.stringify(payload, null, 2);
  fs.writeFileSync("./docs.json", jsonContent, "utf8");
  fs.writeFileSync("./docs.js", `const DATA = ${jsonContent};`, "utf8");

  console.log(`\nSucesso! ${docs.length} documentações capturadas e salvas no docs.js.`);
}

main();