import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// TEST BÁSICO
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente con filtros y miniaturas");
});

// =========================
// ENDPOINT: Buscar productos activos y con stock
// =========================
app.get("/products", async (req, res) => {
  try {
    const query = req.query.q?.trim() || "";
    if (!query) return res.json({ message: "Por favor, incluye un parámetro ?q=" });

    const graphqlQuery = {
      query: `
        {
          products(first: 50, query: "${query}") {
            edges {
              node {
                id
                title
                handle
                status
                totalInventory
                featuredImage { url }
                variants(first: 5) {
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
    const products = data?.data?.products?.edges || [];

    // =========================
    // FILTRO: Activos + con stock
    // =========================
    const activeProducts = products
      .map((edge) => edge.node)
      .filter(
        (p) =>
          (p.status === "active" || p.status === "ACTIVE") &&
          p.totalInventory > 0
      );

    // =========================
    // FORMATO FINAL + miniaturas
    // =========================
    const formatted = activeProducts.flatMap((p) => {
      const variant = p.variants.edges.find((v) => v.node.availableForSale);
      if (!variant) return [];

      const variantId = variant.node.id.split("/").pop();
      let imageUrl = p.featuredImage?.url || null;

      if (imageUrl) {
        imageUrl = imageUrl
          .replace(/\.png(\?.*)?$/, "_200x200.png$1")
          .replace(/\.jpg(\?.*)?$/, "_200x200.jpg$1")
          .replace(/\.jpeg(\?.*)?$/, "_200x200.jpeg$1")
          .replace(/\.webp(\?.*)?$/, "_200x200.webp$1");
      }

      return {
        id: p.id,
        title: p.title,
        price: variant.node.price || "N/A",
        image: imageUrl,
        url: `https://robertaonline.com/products/${p.handle}`,
        add_to_cart: `https://robertaonline.com/cart/${variantId}:1`,
      };
    });

    res.json(formatted.length > 0 ? formatted : { message: "Sin resultados" });
  } catch (error) {
    console.error("Error buscando productos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// =========================
// INICIO DEL SERVIDOR
// =========================
app.listen(port, () => {
  console.log(`✅ Roberta API funcionando en http://localhost:${port}`);
});