// =====================================================
// 🚚 DELHIVERY ROUTES  (drop-in replacement section)
// =====================================================

app.post("/api/delivery/availability", async (req, res) => {
  try {
    const { pincode } = req.body;
    if (!pincode || !/^[1-9][0-9]{5}$/.test(pincode)) {
      return res.status(400).json({ success: false, message: "Valid 6-digit pincode is required" });
    }
    const result = await delhivery.checkDeliveryAvailability(pincode);
    res.json(result);
  } catch (error) {
    console.error("❌ /availability error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to check delivery availability" });
  }
});

app.post("/api/delivery/charges", async (req, res) => {
  try {
    const {
      weight = 0.5,
      pincode,
      origin_pincode = process.env.WAREHOUSE_PINCODE || "332404",
    } = req.body;
    if (!pincode) return res.status(400).json({ success: false, message: "Pincode is required" });
    const result = await delhivery.calculateDeliveryCharges({ weight, pincode, origin_pincode });
    res.json(result);
  } catch (error) {
    console.error("❌ /charges error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to calculate charges" });
  }
});

app.post("/api/delivery/create-shipment", async (req, res) => {
  try {
    const {
      order_id,
      customer_name,
      customer_phone,
      customer_email,
      destination_pincode,
      destination_address,
      destination_city,
      destination_state,
      payment_mode = "Prepaid",
      total_amount  = 0,
      product_description = "Ayurvedic Products",
      weight = 0.5,
    } = req.body;

    if (!order_id || !customer_name || !customer_phone || !destination_pincode || !destination_address) {
      return res.status(400).json({ success: false, message: "Missing required fields: order_id, customer_name, customer_phone, destination_pincode, destination_address" });
    }

    const deliveryPaymentMode = payment_mode.toLowerCase() === "cod" ? "COD" : "Prepaid";

    const result = await delhivery.createShipment({
      order_id,
      customer_name,
      customer_phone,
      customer_email,
      destination_pincode,
      destination_address,
      destination_city:  destination_city  || "",
      destination_state: destination_state || "",
      payment_mode:      deliveryPaymentMode,
      total_amount,
      product_description,
      weight,
    });

    // Persist delivery info on the order record
    if (result.success) {
      try {
        const orders = await dbRead("orders_store", ORDERS_FILE, []);
        const idx = orders.findIndex((o) => o.id === order_id);
        if (idx !== -1) {
          orders[idx].delivery = {
            partner:      "delhivery",
            waybill:      result.waybill,
            shipment_id:  result.shipment_id,
            status:       result.status,
            tracking_url: result.tracking_url,
            created_at:   new Date().toISOString(),
          };
          await dbWrite("orders_store", "orders", orders, ORDERS_FILE);
        }
      } catch (dbError) {
        // Non-fatal — shipment was created, DB update failed
        console.warn("⚠️ Could not update order with delivery info:", dbError.message);
      }
    }

    res.json(result);
  } catch (error) {
    console.error("❌ /create-shipment error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to create shipment" });
  }
});

app.get("/api/delivery/tracking/:waybill", async (req, res) => {
  try {
    const { waybill } = req.params;
    if (!waybill) return res.status(400).json({ success: false, message: "Waybill is required" });
    const result = await delhivery.getShipmentTracking(waybill);
    res.json(result);
  } catch (error) {
    console.error("❌ /tracking error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to get tracking" });
  }
});

app.post("/api/delivery/cancel", async (req, res) => {
  try {
    const { waybill } = req.body;
    if (!waybill) return res.status(400).json({ success: false, message: "Waybill is required" });

    const result = await delhivery.cancelShipment(waybill);

    if (result.success) {
      try {
        const orders = await dbRead("orders_store", ORDERS_FILE, []);
        for (const order of orders) {
          if (order.delivery?.waybill === waybill) {
            order.delivery.status       = "cancelled";
            order.delivery.cancelled_at = new Date().toISOString();
            break;
          }
        }
        await dbWrite("orders_store", "orders", orders, ORDERS_FILE);
      } catch (dbError) {
        console.warn("⚠️ Could not update cancellation status:", dbError.message);
      }
    }

    res.json(result);
  } catch (error) {
    console.error("❌ /cancel error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to cancel shipment" });
  }
});

// ─── register warehouse (run once) ───────────────────────────────────────────
app.post("/api/delivery/register-warehouse", async (req, res) => {
  try {
    const expressUrl = process.env.DELHIVERY_EXPRESS_URL || "https://express.delhivery.com";
    const response = await axios.post(
      `${expressUrl}/api/backend/clientwarehouse/create/`,
      {
        name:           process.env.WAREHOUSE_NAME    || "GS Traders",
        email:          process.env.WAREHOUSE_EMAIL   || "info@ayurmitti.com",
        phone:          process.env.WAREHOUSE_PHONE   || "9636910582",
        address:        process.env.WAREHOUSE_ADDRESS || "SHAHID MAGAN SINGH COLONY, WARD NO-15, Mahroli",
        city:           process.env.WAREHOUSE_CITY    || "Reengus",
        country:        "India",
        pin:            process.env.WAREHOUSE_PINCODE || "332404",
        state:          process.env.WAREHOUSE_STATE   || "Rajasthan",
        return_address: process.env.WAREHOUSE_ADDRESS || "SHAHID MAGAN SINGH COLONY, WARD NO-15, Mahroli",
        return_pin:     process.env.WAREHOUSE_PINCODE || "332404",
        return_city:    process.env.WAREHOUSE_CITY    || "Reengus",
        return_state:   process.env.WAREHOUSE_STATE   || "Rajasthan",
        return_country: "India",
      },
      {
        headers: {
          Authorization:  `Token ${process.env.DELHIVERY_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("❌ Warehouse registration error:", err.message);
    res.status(500).json({
      success: false,
      error:   err.message,
      details: err.response?.data,
    });
  }
});
