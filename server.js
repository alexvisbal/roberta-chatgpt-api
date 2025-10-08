import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import sharp from "sharp";
import axios from "axios";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// TEST ROUTE
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente");
});

// =========================
// ENDPOINT: Buscar productos (solo activos y con stock)
// =========================
app.get("/products", async (req, res) => {
  try {
    const query = req.query.q || "";
    if (!query) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }

    const graphqlQuery = {
      query: `
        {
          products(first: 20, query: "${query} status:active inventory_total:>0") {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
                featuredImage {
                  url
                }
                variants(first: 1) {
                  edges {
                    node {
                      id
                      price
                      availableForSale
                    }
                  }
                }
              }
            }
          }
        }
      `,
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(graphqlQuery),
      }
    );

    const data = await response.json();

    const products =
      data?.data?.products?.edges
        .map((edge) => {
          const node = edge.node;
          const variant = node.variants.edges[0]?.node;

          if (!variant?.availableForSale) return null;

          let imageUrl = node.featuredImage?.url || null;
          if (imageUrl) {
            imageUrl = imageUrl
              .replace(/\.png(\?.*)?$/, "_200x200.png$1")
              .replace(/\.jpg(\?.*)?$/, "_200x200.jpg$1")
              .replace(/\.jpeg(\?.*)?$/, "_200x200.jpeg$1")
              .replace(/\.webp(\?.*)?$/, "_200x200.webp$1");
          }

          return {
            id: node.id,
            variant_id: variant.id,
            title: node.title,
            brand: node.vendor,
            category: node.productType,
            price: variant.price || "N/A",
            image: imageUrl,
            url: `https://robertaonline.com/products/${node.handle}`,
            add_to_cart: `https://robertaonline.com/cart/${variant.id.split("/").pop()}:1`,
          };
        })
        .filter(Boolean) || [];

    res.json(products.length > 0 ? products : { message: "Sin resultados" });
  } catch (error) {
    console.error("Error buscando productos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// =========================
// ENDPOINT: MINIATURA REAL (200x200)
// =========================
app.get("/thumb", async (req, res) => {
  try {
    const imgUrl = req.query.url;
    if (!imgUrl) return res.status(400).send("Falta el parámetro ?url=");

    const response = await axios.get(imgUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://robertaonline.com/",
      },
    });

    if (response.status !== 200) {
      console.error("❌ Error al obtener la imagen:", response.status);
      return res.status(404).send("No se pudo descargar la imagen");
    }

    const resized = await sharp(response.data)
      .resize(200, 200, { fit: "cover" })
      .toFormat("webp", { quality: 85 })
      .toBuffer();

    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "public, max-age=31536000");
    res.send(resized);
  } catch (err) {
    console.error("❌ Error descargando o procesando imagen:", err.message);
    res.status(500).send("Error generando miniatura");
  }
});

// =========================
// ENDPOINT: Crear pedido de prueba
// =========================
app.post("/checkout/create", async (req, res) => {
  try {
    const order = {
      order: {
        line_items: [
          {
            title: "Pedido de prueba desde API",
            quantity: 1,
            price: "10.00",
          },
        ],
        email: "cliente@ejemplo.com",
        financial_status: "pending",
      },
    };

    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2025-07/orders.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(order),
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error creando pedido:", error);
    res.status(500).json({ error: "Error interno al crear pedido" });
  }
});

// =========================
// INICIO DEL SERVIDOR
// =========================
app.listen(port, () => {
  console.log(`✅ Roberta API funcionando en http://localhost:${port}`);
});