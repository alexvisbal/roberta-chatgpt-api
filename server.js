import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// PRUEBA BÁSICA
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente");
});

// =========================
// ENDPOINT: BUSCAR PRODUCTOS
// =========================
app.get("/products", async (req, res) => {
  try {
    const query = req.query.q?.trim() || "";
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
                      inventoryQuantity
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
        ?.map((edge) => {
          const p = edge.node;
          const variant = p.variants.edges[0]?.node;
          if (!variant?.availableForSale || variant?.inventoryQuantity <= 0)
            return null;

          const imageUrl = p.featuredImage?.url || null;
          const variantId = variant?.id?.split("/").pop();
          const addToCart = variantId
            ? `https://robertaonline.com/cart/${variantId}:1`
            : null;

          return {
            id: p.id,
            title: p.title,
            brand: p.vendor || "Roberta Online",
            category: p.productType || "",
            price: variant?.price || "N/A",
            image: imageUrl,
            url: `https://robertaonline.com/products/${p.handle}`,
            add_to_cart: addToCart,
          };
        })
        .filter(Boolean) || [];

    res.json(products.length > 0 ? products : { message: "Sin resultados" });
  } catch (error) {
    console.error("❌ Error buscando productos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// =========================
// ENDPOINT: MINIATURA REAL
// =========================
app.get("/thumb", async (req, res) => {
  try {
    const imgUrl = req.query.url;
    if (!imgUrl) {
      return res.status(400).send("Falta el parámetro ?url=");
    }

    // Descargar imagen desde Shopify
    const response = await fetch(imgUrl);
    if (!response.ok) {
      return res.status(404).send("No se pudo descargar la imagen");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Procesar con sharp
    const resized = await sharp(buffer)
      .resize(200, 200, { fit: "cover", position: "centre" })
      .toFormat("webp", { quality: 85 })
      .toBuffer();

    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "public, max-age=31536000");
    res.send(resized);
  } catch (error) {
    console.error("❌ Error generando miniatura:", error);
    res.status(500).send("Error generando miniatura");
  }
});

// =========================
// INICIO DEL SERVIDOR
// =========================
app.listen(port, () => {
  console.log(`✅ Roberta API funcionando en http://localhost:${port}`);
});