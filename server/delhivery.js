import axios from "axios";

// ================= CONFIG =================
const BASE_URL  = process.env.DELHIVERY_BASE_URL  || "https://express.delhivery.com";
const TRACK_URL = process.env.DELHIVERY_TRACK_URL || "https://dlv-api.delhivery.com";
const API_KEY   = process.env.DELHIVERY_API_KEY;

const authHeaders = () => ({
  Authorization:  `Token ${API_KEY}`,
  "Content-Type": "application/json",
  Accept:         "application/json",
});

// =====================================================
// 📍 CHECK DELIVERY AVAILABILITY BY PINCODE
// =====================================================
export const checkDeliveryAvailability = async (pincode) => {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/c/api/pin-codes/json/?filter_codes=${pincode}`,
      { headers: authHeaders() }
    );

    const codes = data?.delivery_codes || [];
    const available = codes.length > 0;
    const info = codes[0]?.postal_code || {};

    return {
      success:          true,
      available,
      pincode,
      city:             info.city      || null,
      state:            info.state_code || null,
      cash_on_delivery: info.cod       === "Y",
      pre_paid:         info.pre_paid  === "Y",
      pickup:           info.pickup    === "Y",
      data,
    };
  } catch (error) {
    console.error("❌ checkDeliveryAvailability:", error.message);
    return {
      success:   false,
      available: false,
      pincode,
      message:   error.response?.data?.message || error.message,
    };
  }
};

// =====================================================
// 💰 CALCULATE DELIVERY CHARGES
// =====================================================
export const calculateDeliveryCharges = async ({
  weight        = 0.5,
  pincode,
  origin_pincode = process.env.WAREHOUSE_PINCODE || "332404",
}) => {
  try {
    const weightGrams = Math.ceil(weight * 1000);

    const { data } = await axios.get(
      `${BASE_URL}/api/kinko/v1/invoice/charges/.json` +
        `?md=S&ss=Delivered` +
        `&d_pin=${pincode}` +
        `&o_pin=${origin_pincode}` +
        `&cgm=${weightGrams}` +
        `&pt=Pre-paid` +
        `&cod=0`,
      { headers: authHeaders() }
    );

    const charges = Array.isArray(data) ? data[0] : data;

    return {
      success:       true,
      pincode,
      origin_pincode,
      weight_kg:     weight,
      total_charge:  charges?.total_amount || charges?.freight_charge || 0,
      data:          charges,
    };
  } catch (error) {
    console.error("❌ calculateDeliveryCharges:", error.message);
    return {
      success:  false,
      pincode,
      message:  error.response?.data?.message || error.message,
    };
  }
};

// =====================================================
// 📦 CREATE SHIPMENT
// =====================================================
export const createShipment = async ({
  order_id,
  customer_name,
  customer_phone,
  customer_email  = "",
  destination_pincode,
  destination_address,
  destination_city  = "",
  destination_state = "",
  payment_mode      = "Prepaid",
  total_amount      = 0,
  product_description = "Ayurvedic Products",
  weight            = 0.5,
}) => {
  try {
    const warehouseName = process.env.WAREHOUSE_NAME    || "B S OVERSEAS";
    const warehousePin  = process.env.WAREHOUSE_PINCODE || "332404";
    const warehouseCity = process.env.WAREHOUSE_CITY    || "Reengus";
    const warehouseAddr = process.env.WAREHOUSE_ADDRESS || "SHAHID MAGAN SINGH COLONY, WARD NO-15, Mahroli";
    const warehouseState= process.env.WAREHOUSE_STATE   || "Rajasthan";

    const isCOD       = payment_mode.toUpperCase() === "COD";
    const weightGrams = Math.ceil(weight * 1000);

    const shipmentPayload = {
      shipments: [
        {
          name:            customer_name,
          add:             destination_address,
          pin:             String(destination_pincode),
          city:            destination_city,
          state:           destination_state,
          country:         "India",
          phone:           String(customer_phone),
          order:           String(order_id),
          payment_mode:    isCOD ? "COD" : "Pre-paid",
          return_pin:      warehousePin,
          return_city:     warehouseCity,
          return_phone:    process.env.WAREHOUSE_PHONE || "9636910582",
          return_add:      warehouseAddr,
          return_state:    warehouseState,
          return_country:  "India",
          products_desc:   product_description,
          hsn_code:        "",
          cod_amount:      isCOD ? String(total_amount) : "0",
          order_date:      new Date().toISOString().split("T")[0],
          total_amount:    String(total_amount),
          seller_add:      warehouseAddr,
          seller_name:     warehouseName,
          seller_inv:      String(order_id),
          quantity:        "1",
          weight:          String(weightGrams),
          shipment_width:  "10",
          shipment_height: "10",
          shipment_length: "15",
          comment:         product_description,
          invoice_value:   String(total_amount),
          invoice_date:    new Date().toISOString().split("T")[0],
        },
      ],
      pickup_location: { name: warehouseName },
    };

    const formData = new URLSearchParams();
    formData.append("format", "json");
    formData.append("data", JSON.stringify(shipmentPayload));

    const { data } = await axios.post(
      `${BASE_URL}/api/cmu/create.json`,
      formData.toString(),
      {
        headers: {
          Authorization:  `Token ${API_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept:         "application/json",
        },
      }
    );

    const pkg = data?.packages?.[0];

    if (!pkg) {
      return {
        success: false,
        message: "No package data returned from Delhivery",
        raw:     data,
      };
    }

    if (pkg.error || pkg.error_message) {
      return {
        success: false,
        message: pkg.error_message || pkg.error || "Shipment creation failed",
        raw:     data,
      };
    }

    return {
      success:      true,
      waybill:      pkg.waybill,
      shipment_id:  pkg.refnum    || pkg.waybill,
      status:       pkg.status    || "Manifested",
      tracking_url: `https://www.delhivery.com/track/package/${pkg.waybill}`,
      cod_amount:   pkg.cod_amount,
      data,
    };
  } catch (error) {
    console.error("❌ createShipment:", error.message, error.response?.data);
    return {
      success: false,
      message: error.response?.data?.message || error.message,
    };
  }
};

// =====================================================
// 🔍 TRACK SHIPMENT
// =====================================================
export const getShipmentTracking = async (waybill) => {
  try {
    const { data } = await axios.get(
      `${TRACK_URL}/api/v1/packages/json/?waybill=${waybill}`,
      { headers: authHeaders() }
    );

    const shipment   = data?.ShipmentData?.[0]?.Shipment || null;
    const scans      = shipment?.Scans || [];
    const lastScan   = scans[scans.length - 1]?.ScanDetail || {};

    return {
      success:      true,
      waybill,
      status:       shipment?.Status   || "Unknown",
      status_text:  shipment?.StatusType || lastScan.Instructions || "",
      location:     lastScan.ScannedLocation || "",
      last_updated: lastScan.ScanDateTime    || null,
      expected_date: shipment?.ExpectedDeliveryDate || null,
      tracking_url: `https://www.delhivery.com/track/package/${waybill}`,
      scans:        scans.map((s) => ({
        status:    s.ScanDetail?.Instructions || "",
        location:  s.ScanDetail?.ScannedLocation || "",
        timestamp: s.ScanDetail?.ScanDateTime  || "",
      })),
      data,
    };
  } catch (error) {
    console.error("❌ getShipmentTracking:", error.message);
    return {
      success: false,
      waybill,
      message: error.response?.data?.message || error.message,
    };
  }
};

// =====================================================
// ❌ CANCEL SHIPMENT
// =====================================================
export const cancelShipment = async (waybill) => {
  try {
    const formData = new URLSearchParams();
    formData.append("waybill", waybill);
    formData.append("cancellation", "true");

    const { data } = await axios.post(
      `${BASE_URL}/api/p/edit`,
      formData.toString(),
      {
        headers: {
          Authorization:  `Token ${API_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept:         "application/json",
        },
      }
    );

    const success = data?.status === true || data?.cancellation_status?.toLowerCase?.() === "success";

    return {
      success,
      waybill,
      message: success ? "Shipment cancelled successfully" : (data?.message || "Cancellation may have failed"),
      data,
    };
  } catch (error) {
    console.error("❌ cancelShipment:", error.message);
    return {
      success: false,
      waybill,
      message: error.response?.data?.message || error.message,
    };
  }
};
