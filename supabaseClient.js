    // server/supabaseClient.js
    import { createClient } from "@supabase/supabase-js";
    import dotenv from "dotenv";
    dotenv.config(); // charge les variables du .env

    export const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
    );