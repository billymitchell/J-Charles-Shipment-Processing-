const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json()); // Parse JSON bodies before route handlers.
require('dotenv').config();

// Structured JSON logger to keep logs machine-readable across platforms.
function log(level, message, meta = {}) {
    const entry = {
        level,
        message,
        time: new Date().toISOString(),
        ...meta
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

// Create a consistent error shape that the error middleware can serialize.
function createError(message, statusCode, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (details) {
        error.details = details;
    }
    return error;
}

// Attach a request ID, response timing, and a completion log for traceability.
app.use((req, res, next) => {
    const start = Date.now();
    req.request_id = crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
    res.setHeader('X-Request-Id', req.request_id);

    res.on('finish', () => {
        log('info', 'request.complete', {
            request_id: req.request_id,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            duration_ms: Date.now() - start
        });
    });

    next();
});

// Shipment method mapping table used to normalize shipping method labels.
const shipmentMethodMapping = {
    "GRND": "Ground",
    "RES": "Residential",
    "3DAY": "3-Day Select",
    "2DAY": "2-Day Air",
    "1DAY": "Next Day Air",
    "STD": "Standard",
    "EXP": "Express"
};

// Normalize carrier + method into the expected outbound format.
function parseShippingMethod(methodSource) {
    if (!methodSource) {
        return { carrier_code: null, shipment_method: null };
    }

    const trimmed = String(methodSource).trim();
    if (!trimmed) {
        return { carrier_code: null, shipment_method: null };
    }

    const parts = trimmed.split(/\s+/);
    const carrier_code = parts.length > 1 ? parts.shift() : null;
    const rawMethod = parts.join(' ');
    const normalizedCode = rawMethod.toUpperCase();
    const shipment_method = shipmentMethodMapping[rawMethod]
        || shipmentMethodMapping[normalizedCode]
        || rawMethod;

    return {
        carrier_code: carrier_code || null,
        shipment_method: shipment_method || null
    };
}

// Build line items for the OrderDesk payload from either an array or legacy fields.
function buildOrderItems(attachment) {
    if (!attachment || typeof attachment !== 'object') {
        return [];
    }

    if (Array.isArray(attachment.order_items)) {
        return attachment.order_items
            .map((item) => {
                if (!item || typeof item !== 'object') {
                    return null;
                }

                const code = item.code || item.sku || null;
                const quantity = Number(item.quantity || item.qty || 0);
                if (!code || !Number.isFinite(quantity) || quantity <= 0) {
                    return null;
                }

                return { code, quantity };
            })
            .filter(Boolean);
    }

    const code = attachment.order_items_code || attachment.sku || null;
    const quantity = Number(attachment.shipment_quantity || attachment.quantity || 0);
    if (!code || !Number.isFinite(quantity) || quantity <= 0) {
        return [];
    }

    return [{ code, quantity }];
}

// Single route to process inbound shipment data and forward to OrderDesk.
app.post('/', async (req, res, next) => {
    try {
        // Validate the request body.
        const data = req.body;
        if (!data || typeof data.mail_attachments !== 'object') {
            throw createError("Invalid input: 'mail_attachments' must be an object.", 400);
        }

        const attachment = data.mail_attachments;

        // Validate required fields in the attachment.
        if (!attachment.tracking_number) {
            throw createError("Invalid attachment: Missing 'tracking_number'.", 400);
        }

        const shippingMethodSource = attachment.brightstores_shipping_method
            || attachment.ship_via_description
            || null;
        const { carrier_code, shipment_method } = parseShippingMethod(shippingMethodSource);
        const order_items = buildOrderItems(attachment);

        // Construct the payload to send to the external API.
        const extractedData = {
            source_id: attachment.brightstores_order_id
                || attachment.jcharles_order_number
                || attachment.customer_po
                || null,
            tracking_number: attachment.tracking_number,
            carrier_code: carrier_code || null,
            shipment_method: shipment_method || null,
            order_items
        };

        // Log key payload fields without dumping raw customer data.
        log('info', 'payload.prepared', {
            request_id: req.request_id,
            source_id: extractedData.source_id,
            tracking_number: extractedData.tracking_number,
            carrier_code: extractedData.carrier_code,
            shipment_method: extractedData.shipment_method,
            order_items_count: extractedData.order_items.length
        });

        // Send the payload to the external API.
        const response = await fetch('https://orderdesk-single-order-ship-65ffd8ceba36.herokuapp.com/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(extractedData)
        });

        // Handle non-OK responses from the external API.
        if (!response.ok) {
            const errorResponse = await response.text();
            let formattedError = { raw: errorResponse };
            try {
                formattedError = JSON.parse(errorResponse);
            } catch (parseError) {
                formattedError = { raw: errorResponse };
            }

            // Preserve upstream error context for debugging.
            const errorDetails = {
                status: `${response.status} ${response.statusText}`,
                requestBody: extractedData,
                serverResponse: formattedError
            };
            const apiError = createError("Failed to submit shipment", 400, errorDetails);
            apiError.requestBody = extractedData;
            throw apiError;
        }

        // Parse and return the successful response from the external API.
        const responseData = await response.json();
        log('info', 'payload.sent', {
            request_id: req.request_id,
            orderdesk_status: response.status
        });
        res.json({ success: true, response: responseData, request_id: req.request_id });

    } catch (error) {
        // Forward errors to the centralized error handler.
        error.request_id = req.request_id;
        next(error);
    }
});

// Centralized error handler so all failures return a consistent JSON response.
app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    log('error', 'request.error', {
        request_id: error.request_id || req.request_id,
        status: statusCode,
        message: error.message,
        stack: error.stack,
        details: error.details
    });

    res.status(statusCode).json({
        success: false,
        message: error.message || 'An unexpected error occurred',
        request_id: error.request_id || req.request_id,
        details: error.details || null
    });
});

// Capture process-level errors for visibility in logs.
process.on('unhandledRejection', (reason) => {
    log('error', 'process.unhandledRejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : null
    });
});

// Capture synchronous exceptions that escape the request handler.
process.on('uncaughtException', (error) => {
    log('error', 'process.uncaughtException', {
        message: error.message,
        stack: error.stack
    });
});

// Start the server.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
