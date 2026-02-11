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

                const id = Number(
                    item.order_items_brightstores_line_item_id
                    || item.order_items_id
                    || item.id
                    || item.brightstores_line_item_id
                    || 0
                );
                const quantity = Number(item.quantity || item.qty || item.shipment_quantity || 0);
                if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
                    return null;
                }

                return { id, quantity };
            })
            .filter(Boolean);
    }

    const id = Number(
        attachment.order_items_brightstores_line_item_id
        || attachment.order_items_id
        || attachment.brightstores_line_item_id
        || attachment.order_item_id
        || attachment.line_item_id
        || 0
    );
    const quantity = Number(attachment.shipment_quantity || attachment.quantity || 0);
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
        return [];
    }

    return [{ id, quantity }];
}

function resolveSourceId(attachment) {
    if (!attachment || typeof attachment !== 'object') {
        return null;
    }

    return attachment.brightstores_order_id
        || attachment.jcharles_order_number
        || attachment.customer_po
        || null;
}

function resolveShippingMethod(attachment) {
    if (!attachment || typeof attachment !== 'object') {
        return { carrier_code: null, shipment_method: null };
    }

    const shippingMethodSource = attachment.brightstores_shipping_method
        || attachment.ship_via_description
        || null;
    return parseShippingMethod(shippingMethodSource);
}

function buildGroupedShipments(attachments) {
    const grouped = new Map();

    attachments.forEach((attachment) => {
        if (!attachment || typeof attachment !== 'object') {
            return;
        }

        const tracking_number = attachment.tracking_number || null;
        if (!tracking_number) {
            return;
        }

        const entry = grouped.get(tracking_number) || {
            tracking_number,
            source_id: resolveSourceId(attachment),
            ...resolveShippingMethod(attachment),
            order_items: []
        };

        if (!entry.source_id) {
            entry.source_id = resolveSourceId(attachment);
        }

        if (!entry.carrier_code || !entry.shipment_method) {
            const method = resolveShippingMethod(attachment);
            entry.carrier_code = entry.carrier_code || method.carrier_code;
            entry.shipment_method = entry.shipment_method || method.shipment_method;
        }

        entry.order_items.push(...buildOrderItems(attachment));
        grouped.set(tracking_number, entry);
    });

    return Array.from(grouped.values());
}

// Single route to process inbound shipment data and forward to OrderDesk.
app.post('/', async (req, res, next) => {
    try {
        // Validate the request body.
        const data = req.body;
        if (!data || typeof data.mail_attachments !== 'object') {
            throw createError("Invalid input: 'mail_attachments' must be an object or array.", 400);
        }

        const attachments = Array.isArray(data.mail_attachments)
            ? data.mail_attachments
            : [data.mail_attachments];

        const shipments = buildGroupedShipments(attachments);
        if (!shipments.length) {
            throw createError("Invalid attachment: Missing 'tracking_number'.", 400);
        }

        const responses = [];
        for (const shipment of shipments) {
            // Log key payload fields without dumping raw customer data.
            log('info', 'payload.prepared', {
                request_id: req.request_id,
                source_id: shipment.source_id,
                tracking_number: shipment.tracking_number,
                carrier_code: shipment.carrier_code,
                shipment_method: shipment.shipment_method,
                order_items_count: shipment.order_items.length
            });

            const response = await fetch('https://orderdesk-single-order-ship-65ffd8ceba36.herokuapp.com/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(shipment)
            });

            if (!response.ok) {
                const errorResponse = await response.text();
                let formattedError = { raw: errorResponse };
                try {
                    formattedError = JSON.parse(errorResponse);
                } catch (parseError) {
                    formattedError = { raw: errorResponse };
                }

                const errorDetails = {
                    status: `${response.status} ${response.statusText}`,
                    requestBody: shipment,
                    serverResponse: formattedError
                };
                const apiError = createError("Failed to submit shipment", 400, errorDetails);
                apiError.requestBody = shipment;
                throw apiError;
            }

            const responseData = await response.json();
            responses.push({
                tracking_number: shipment.tracking_number,
                response: responseData
            });
        }

        log('info', 'payload.sent', {
            request_id: req.request_id,
            shipment_count: responses.length
        });
        res.json({ success: true, responses, request_id: req.request_id });

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
