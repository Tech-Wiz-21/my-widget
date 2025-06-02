const express = require("express");
const cors = require("cors");
const path = require('path');
const bodyParser = require("body-parser");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());
// Add this to your backend after your existing middleware
app.use(express.static('public'));

// Add widget route
app.get('/widget.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

let accessToken = null;
let tokenCreatedAt = 0;
const tokenExpiry = 3600 * 1000; // 1 hour

async function getAccessToken() {
    const now = Date.now();

    if (!accessToken || now - tokenCreatedAt > tokenExpiry - 60000) {
        console.log("🔁 Refreshing access token...");

        const params = new URLSearchParams();
        params.append("refresh_token", process.env.ZOHO_REFRESH_TOKEN);
        params.append("client_id", process.env.ZOHO_CLIENT_ID);
        params.append("client_secret", process.env.ZOHO_CLIENT_SECRET);
        params.append("grant_type", "refresh_token");

        const response = await fetch("https://accounts.zoho.eu/oauth/v2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params
        });

        const data = await response.json();

        if (data.access_token) {
            accessToken = data.access_token;
            tokenCreatedAt = now;
            console.log("✅ Access token refreshed successfully");
        } else {
            console.error("❌ Failed to refresh access token", data);
            throw new Error("Failed to refresh access token");
        }
    }

    return accessToken;
}



app.post("/api/schedule-calls", async (req, res) => {
    try {
        console.log("🔵 === ENHANCED BULK CALL SCHEDULER ===");
        console.log("📥 Received request body:", JSON.stringify(req.body, null, 2));

        const { leadIds, start_time, call_owner, subject, purpose, agenda, preferred_timings, reminder } = req.body;

        // Input validation
        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ message: "❌ No lead IDs provided" });
        }

        if (leadIds.length > 500) {
            return res.status(400).json({ message: "❌ Maximum 500 leads per request" });
        }

        const token = await getAccessToken();

        // Convert datetime to ISO format
        let formattedDateTime;
        if (start_time.includes("T") && start_time.includes("Z")) {
            formattedDateTime = start_time;
            console.log("🕐 DateTime already in ISO format:", formattedDateTime);
        } else {
            formattedDateTime = start_time.replace(" ", "T") + "+05:30"; // IST timezone
            console.log("🕐 Converted datetime:", start_time, "→", formattedDateTime);
        }

        console.log(`📊 Processing ${leadIds.length} leads in optimized batches...`);

        // Configuration
        const BATCH_SIZE = 50; // Reduced because we're making 2 API calls per lead
        const RATE_LIMIT_DELAY = 1000;
        const MAX_RETRIES = 3;

        const results = [];
        const errors = [];
        let successCount = 0;
        let totalProcessed = 0;

        // Process leads in batches
        for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
            const batchLeads = leadIds.slice(i, i + BATCH_SIZE);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(leadIds.length / BATCH_SIZE);

            console.log(`\n🔄 Processing batch ${batchNumber}/${totalBatches} (${batchLeads.length} leads)`);

            // Prepare CALLS data
            const batchCallData = batchLeads.map(leadId => ({
                Subject: subject,
                Call_Type: "Outbound",
                Call_Start_Time: formattedDateTime,
                Call_Purpose: purpose || "Prospecting",
                Call_Agenda: agenda || "Follow-up call",
                Preferred_Call_Timings: preferred_timings || "None",
                $se_module: "Leads",
                What_Id: leadId,
                Call_Result: "Scheduled",
                Owner: { id: call_owner }
            }));

            // Prepare EVENTS data (for reminders)
            // Prepare EVENTS data (for reminders)
            const batchEventData = batchLeads.map(leadId => {
                // Simple string manipulation to add 30 minutes
                const [datePart, timePart] = formattedDateTime.split('T');
                const [timeOnly, timezone] = timePart.split('+');
                const [hours, minutes, seconds] = timeOnly.split(':');

                const totalMinutes = parseInt(hours) * 60 + parseInt(minutes);
                const endTotalMinutes = totalMinutes + 30; // Add 30 minutes
                const endHours = Math.floor(endTotalMinutes / 60) % 24; // Handle day overflow
                const endMins = endTotalMinutes % 60;

                const formattedEndDateTime = `${datePart}T${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:${seconds}+05:30`;

                console.log(`🔍 Start: ${formattedDateTime}`);
                console.log(`🔍 End: ${formattedEndDateTime}`);

                const eventData = {
                    Event_Title: `Call: ${subject}`,
                    Start_DateTime: formattedDateTime,
                    End_DateTime: formattedEndDateTime,
                    Event_Type: "Call",
                    Description: agenda || "Follow-up call",
                    $se_module: "Leads",
                    What_Id: leadId,
                    Owner: { id: call_owner }
                };

                // Add reminder to events only
                if (reminder && reminder !== "None" && reminder !== "") {
                    const reminderText = {
                        "5": "5 minutes before",
                        "10": "10 minutes before",
                        "15": "15 minutes before",
                        "30": "30 minutes before",
                        "60": "1 hour before"
                    }[reminder];

                    if (reminderText) {
                        eventData.Reminder = reminderText;
                    }
                }

                return eventData;
            });
            // Retry logic for batch processing
            let retryCount = 0;
            let batchSuccess = false;

            while (retryCount < MAX_RETRIES && !batchSuccess) {
                try {
                    console.log(`📤 Sending batch ${batchNumber} (attempt ${retryCount + 1}/${MAX_RETRIES})`);

                    // STEP 1: Create Calls
                    console.log(`📞 Creating calls for batch ${batchNumber}...`);
                    const callsResponse = await fetch("https://www.zohoapis.eu/crm/v2/Calls", {
                        method: "POST",
                        headers: {
                            Authorization: `Zoho-oauthtoken ${token}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({ data: batchCallData })
                    });

                    const callsResult = await callsResponse.json();

                    // STEP 2: Create Events (for reminders)
                    console.log(`📅 Creating events for batch ${batchNumber}...`);
                    const eventsResponse = await fetch("https://www.zohoapis.eu/crm/v2/Events", {
                        method: "POST",
                        headers: {
                            Authorization: `Zoho-oauthtoken ${token}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({ data: batchEventData })
                    });

                    const eventsResult = await eventsResponse.json();
                    // 🔍 ADD THESE DEBUG LINES:
                    console.log(`📅 Events API response status: ${eventsResponse.status}`);
                    console.log(`📅 Events API response:`, JSON.stringify(eventsResult, null, 2));
                    if (callsResponse.ok && callsResult.data) {
                        console.log(`✅ Batch ${batchNumber} completed successfully`);

                        // Process individual results
                        callsResult.data.forEach((callResult, index) => {
                            const leadId = batchLeads[index];
                            const eventResult = eventsResult.data?.[index];
                            totalProcessed++;

                            if (callResult.code === "SUCCESS") {
                                successCount++;
                                console.log(`  ✅ Lead ${leadId}: Call created (ID: ${callResult.details.id})`);

                                if (eventResult?.code === "SUCCESS") {
                                    console.log(`  📅 Lead ${leadId}: Event created (ID: ${eventResult.details.id})`);
                                } else {
                                    console.log(`  ⚠️ Lead ${leadId}: Call created but event failed`);
                                }
                            } else {
                                console.log(`  ❌ Lead ${leadId}: ${callResult.message}`);
                                errors.push({
                                    leadId: leadId,
                                    error: callResult.message,
                                    details: callResult.details
                                });
                            }

                            results.push({
                                leadId: leadId,
                                success: callResult.code === "SUCCESS",
                                callId: callResult.details?.id,
                                eventId: eventResult?.details?.id,
                                message: callResult.message,
                                code: callResult.code
                            });
                        });

                        batchSuccess = true;
                    } else {
                        throw new Error(`Batch API error: ${callsResponse.status} - ${JSON.stringify(callsResult)}`);
                    }

                } catch (batchError) {
                    retryCount++;
                    console.log(`❌ Batch ${batchNumber} attempt ${retryCount} failed:`, batchError.message);

                    if (retryCount < MAX_RETRIES) {
                        const retryDelay = RATE_LIMIT_DELAY * retryCount;
                        console.log(`⏳ Retrying batch ${batchNumber} in ${retryDelay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    } else {
                        // Mark all leads in this batch as failed
                        batchLeads.forEach(leadId => {
                            totalProcessed++;
                            errors.push({
                                leadId: leadId,
                                error: `Batch processing failed after ${MAX_RETRIES} attempts`,
                                details: batchError.message
                            });
                            results.push({
                                leadId: leadId,
                                success: false,
                                message: `Batch processing failed: ${batchError.message}`,
                                code: "BATCH_FAILED"
                            });
                        });
                    }
                }
            }

            // Rate limiting: Wait between batches
            if (i + BATCH_SIZE < leadIds.length) {
                console.log(`⏳ Waiting ${RATE_LIMIT_DELAY}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
            }
        }

        // Summary
        const failureCount = totalProcessed - successCount;
        const successRate = ((successCount / totalProcessed) * 100).toFixed(1);

        console.log(`\n📊 PROCESSING COMPLETE:`);
        console.log(`   Total Leads: ${leadIds.length}`);
        console.log(`   Successful Calls: ${successCount}`);
        console.log(`   Failed Calls: ${failureCount}`);
        console.log(`   Success Rate: ${successRate}%`);

        const responseData = {
            message: `✅ Bulk processing complete: ${successCount}/${leadIds.length} calls + events created`,
            summary: {
                totalLeads: leadIds.length,
                successfulCalls: successCount,
                failedCalls: failureCount,
                successRate: `${successRate}%`,
                batchesProcessed: Math.ceil(leadIds.length / BATCH_SIZE)
            },
            results: results,
            errors: errors.length > 0 ? errors : undefined
        };

        // Return appropriate status code
        if (successCount === leadIds.length) {
            res.status(200).json(responseData);
        } else if (successCount > 0) {
            res.status(207).json(responseData);
        } else {
            res.status(500).json(responseData);
        }

    } catch (err) {
        console.error("❌ ENHANCED API ERROR:", err);
        res.status(500).json({
            message: "❌ Internal Server Error",
            error: err.toString(),
            timestamp: new Date().toISOString()
        });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("✅ Server running on port", PORT);
});