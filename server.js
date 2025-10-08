import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// =========================
// TEST ENDPOINT
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Roberta API funcionando correctamente");
});

// =========================
// ENDPOINT: Buscar productos (GraphQL estable)
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
          products(first: 50, query: "${query}") {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
                status
                totalInventory
                featuredImage { url }
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

    if (!data?.data?.products?.edges?.length) {
      return res.json({ message: "Sin resultados" });
    }

    // Filtrar activos y con stock
    const products = data.data.products.edges
      .map((edge) => edge.node)
      .filter(
        (p) =>
          p.status === "ACTIVE" &&
          (p.totalInventory ?? 0) > 0 &&
          p.variants.edges?.[0]?.node?.availableForSale
      )
      .slice(0, 10)
      .map((p) => {
        const variant = p.variants.edges[0]?.node;
        return {
          id: p.id,
          variant_id: variant?.id?.split("/").pop(),
          title: p.title,
          brand: p.vendor || "Sin marca",
          category: p.productType || "",
          price: variant?.price || "N/A",
          image: p.featuredImage?.url || null,
          url: `https://robertaonline.com/products/${p.handle}`,
          add_to_cart: variant
            ? `https://robertaonline.com/cart/${variant.id.split("/").pop()}:1`
            : null,
        };
      });

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