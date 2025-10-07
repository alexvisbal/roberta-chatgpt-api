import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// PRUEBA BÁSICA DEL SERVIDOR
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente");
});

// =========================
// ENDPOINT: Buscar productos (GraphQL)
// =========================
app.get("/products", async (req, res) => {
  try {
    const query = req.query.q || "";
    if (!query) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }

    // === GraphQL: solo productos activos, publicados y con stock ===
    const graphqlQuery = {
      query: `
        {
          products(first: 30, query: "${query} status:active published_status:published") {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
                totalInventory
                featuredImage { url }
                variants(first: 3) {
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

    // === Filtrar productos activos, publicados y con stock ===
    const products =
      data?.data?.products?.edges
        .map((edge) => edge.node)
        .filter(
          (p) =>
            p.totalInventory > 0 &&
            p.variants.edges.some(
              (v) => v.node.availableForSale && v.node.inventoryQuantity > 0
            )
        )
        .map((p) => {
          // === Miniaturas proporcionales (_medium o _small) ===
          let imageUrl = p.featuredImage?.url || null;
          if (imageUrl) {
            imageUrl = imageUrl
              .replace(/\.png(\?.*)?$/, "_medium.png$1")
              .replace(/\.jpg(\?.*)?$/, "_medium.jpg$1")
              .replace(/\.jpeg(\?.*)?$/, "_medium.jpeg$1")
              .replace(/\.webp(\?.*)?$/, "_medium.webp$1");
          }

          const firstVariant = p.variants.edges[0]?.node || {};
          const variantId = firstVariant.id
            ? firstVariant.id.split("/").pop()
            : null;

          return {
            id: p.id,
            variant_id: variantId,
            title: p.title,
            brand: p.vendor || "",
            category: p.productType || "",
            price: firstVariant.price || "N/A",
            image: imageUrl,
            url: `https://robertaonline.com/products/${p.handle}`,
            add_to_cart: variantId
              ? `https://robertaonline.com/cart/${variantId}:1`
              : null,
          };
        }) || [];

    res.json(products.length > 0 ? products : { message: "Sin resultados" });
  } catch (error) {
    console.error("Error buscando productos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ==================================
// ENDPOINT: Crear pedido de prueba
// ==================================
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