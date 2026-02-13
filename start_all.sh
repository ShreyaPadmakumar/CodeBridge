#!/bin/bash

# Function to kill processes on exit
cleanup() {
    echo "Shutting down..."
    kill $(jobs -p) 2>/dev/null
    exit
}
trap cleanup EXIT

# Start MongoDB
echo "🚀 Starting MongoDB..."
mkdir -p mongodb_data
mongod --dbpath ./mongodb_data --bind_ip 127.0.0.1 --fork --logpath ./mongodb_data/mongod.log

# Wait for MongoDB to be ready
echo "⏳ Waiting for MongoDB..."
sleep 3

# Start Server
echo "🚀 Starting Backend Server..."
cd server
npm run dev &
SERVER_PID=$!
cd ..

# Wait for Server to be ready (simple sleep for now)
echo "⏳ Waiting for Backend..."
sleep 5

# Start Client
echo "🚀 Starting Frontend Client..."
npm run dev
