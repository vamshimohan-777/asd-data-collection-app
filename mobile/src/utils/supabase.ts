import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://pvnxallyisjavbqmcpbs.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2bnhhbGx5aXNqYXZicW1jcGJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NDAwODMsImV4cCI6MjA5MjMxNjA4M30.hf4EB5TphSdr9q_UO4MncxBvcq2_f9YZiKvnEgagO5o';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
