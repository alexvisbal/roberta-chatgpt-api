import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

// ======================================================
// PEQUEÑA FUNCIÓN DE SIMILITUD ENTRE PALABRAS
// ======================================================
function similarity(a, b) {
  a = a.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  b = b.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  const longerLength = longer.length;

  let same = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) same++;
  }
  return same / longerLength;
}

// ======================================================
// ENDPOINT PRINCIPAL /products (búsqueda difusa robusta)
// ======================================================
app.get("/products", async (req, res) => {
  try {
    const queryRaw = req.query.q || "";
    if (!queryRaw) {
      return res.json({ message: "Por favor, incluye un parámetro ?q=" });
    }

    const query = queryRaw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    // Traer productos activos (solo lo necesario)
    const graphqlQuery = {
      query: `
        {
          products(first: 200, query: "status:active") {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
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

    // ======================================================
    // FILTRAR LOCALMENTE POR SIMILITUD
    // ======================================================
    const allProducts = data.data.products.edges.map((edge) => edge.node);

    const filtered = allProducts.filter((p) => {
      const vendor = p.vendor || "";
      const title = p.title || "";
      const type = p.productType || "";

      const text = `${vendor} ${title} ${type}`
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      // coincidencia si contiene o es similar
      return (
        text.includes(query) ||
        similarity(vendor, query) > 0.6 ||
        similarity(title, query) > 0.6 ||
        similarity(type, query) > 0.6
      );
    });

    const available = filtered
      .filter(
        (p) =>
          p.totalInventory > 0 &&
          p.variants.edges?.[0]?.node?.availableForSale
      )
      .slice(0, 10)
      .map((p) => {
        const variant = p.variants.edges[0]?.node;
        const imageUrl =
          p.featuredImage?.url?.replace(
            /(\.[a-z]+)(\?.*)?$/,
            "_200x200$1"
          ) || null;

        return {
          id: p.id,
          variant_id: variant?.id?.split("/").pop(),
          title: p.title,
          brand: p.vendor || "Sin marca",
          category: p.productType || "",
          price: variant?.price || "N/A",
          image: imageUrl,
          url: `https://robertaonline.com/products/${p.handle}`,
          add_to_cart: variant
            ? `https://robertaonline.com/cart/${variant.id.split("/").pop()}:1`
            : null,
        };
      });

    res.json(available.length > 0 ? available : { message: "Sin resultados" });
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