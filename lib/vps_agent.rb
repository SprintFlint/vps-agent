# frozen_string_literal: true

require "thor"
require "json"
require "websocket-client-simple"
require "httparty"
require "logger"
require "fileutils"

# VPS Agent CLI
module VPSAgent
  VERSION = "0.1.0"
  CONFIG_DIR = File.expand_path("~/.vps-agent")
  CONFIG_FILE = File.join(CONFIG_DIR, "config.json")
  LOG_FILE = File.join(CONFIG_DIR, "agent.log")

  class Config
    include HTTParty
    
    def self.config_dir; VPSAgent::CONFIG_DIR; end
    def self.config_file; VPSAgent::CONFIG_FILE; end
    
    def self.load
      return {} unless File.exist?(config_file)
      JSON.parse(File.read(config_file), symbolize_names: true)
    rescue JSON::ParserError
      {}
    end

    def self.save(config)
      FileUtils.mkdir_p(config_dir)
      File.write(config_file, JSON.pretty_generate(config))
    end

    def self.get(key)
      load[key]
    end

    def self.set(key, value)
      config = load
      config[key] = value
      save(config)
    end

    def self.clear
      FileUtils.rm_rf(CONFIG_DIR)
    end
  end

  class Logger
    def self.instance
      @instance ||= ::Logger.new(LOG_FILE).tap do |log|
        log.level = ::Logger::INFO
        log.formatter = proc do |severity, datetime, progname, msg|
          "[#{datetime.strftime('%Y-%m-%d %H:%M:%S')}] #{severity}: #{msg}\n"
        end
      end
    end

    def self.info(msg); instance.info(msg); end
    def self.error(msg); instance.error(msg); end
    def self.debug(msg); instance.debug(msg); end
  end

  class API
    include HTTParty
    format :json
    
    def self.base_uri(uri = nil)
      @base_uri = uri if uri
      @base_uri || Config.get(:api_url) || "https://api.sprintflint.com"
    end

    def self.headers
      {
        "Content-Type" => "application/json",
        "Authorization" => "Bearer #{Config.get(:token)}"
      }
    end

    def self.register(name:, hostname:, public_key:)
      post("#{base_uri}/v1/agents/register", body: {
        name: name,
        hostname: hostname,
        public_key: public_key,
        os: RUBY_PLATFORM
      }.to_json, headers: { "Content-Type" => "application/json" })
    end

    def self.heartbeat(agent_id:, status: "online", jobs: [])
      post("#{base_uri}/v1/agents/#{agent_id}/heartbeat", 
           body: { status: status, jobs: jobs, timestamp: Time.now.utc.iso8601 }.to_json,
           headers: headers)
    end

    def self.update_job_status(job_id, status:, logs: nil, output: nil, exit_code: nil)
      body = { status: status }
      body[:logs] = logs if logs
      body[:output] = output if output
      body[:exit_code] = exit_code unless exit_code.nil?
      body[:completed_at] = Time.now.utc.iso8601 if status == "completed" || status == "failed"
      
      post("#{base_uri}/v1/jobs/#{job_id}/status", body: body.to_json, headers: headers)
    end
  end

  class WebSocketClient
    def initialize(url:, agent_id:, token:)
      @url = url
      @agent_id = agent_id
      @token = token
      @ws = nil
      @connected = false
      @reconnect_delay = 5
    end

    def connect
      Logger.info("Connecting to WebSocket: #{@url}")
      
      @ws = WebSocket::Client::Simple.connect(@url, headers: {
        "Authorization" => "Bearer #{@token}",
        "X-Agent-ID" => @agent_id
      })

      @ws.on :open do |e|
        Logger.info("WebSocket connected")
        @connected = true
        @reconnect_delay = 5
        send_message(type: "agent_connected", agent_id: @agent_id)
      end

      @ws.on :message do |msg|
        handle_message(JSON.parse(msg.data, symbolize_names: true))
      end

      @ws.on :close do |e|
        Logger.info("WebSocket closed: #{e}")
        @connected = false
        schedule_reconnect
      end

      @ws.on :error do |e|
        Logger.error("WebSocket error: #{e}")
      end

      self
    end

    def connected?
      @connected
    end

    def send_message(data)
      return unless @ws && @connected
      @ws.send(data.to_json)
    end

    def send_log_chunk(job_id, chunk)
      send_message(type: "log_chunk", job_id: job_id, chunk: chunk, timestamp: Time.now.utc.iso8601)
    end

    def close
      @ws&.close
    end

    private

    def handle_message(msg)
      Logger.info("Received message: #{msg[:type]}")
      
      case msg[:type]
      when "execute_job"
        JobRunner.new(msg[:job], self).run_async
      when "ping"
        send_message(type: "pong", timestamp: Time.now.utc.iso8601)
      when "kill_job"
        JobRunner.kill(msg[:job_id])
      end
    rescue => e
      Logger.error("Error handling message: #{e.message}")
    end

    def schedule_reconnect
      Thread.new do
        sleep @reconnect_delay
        @reconnect_delay = [@reconnect_delay * 2, 60].min
        Logger.info("Attempting reconnect...")
        connect
      end
    end
  end

  class JobRunner
    @@running_jobs = {}
    @@mutex = Mutex.new

    def initialize(job, ws_client)
      @job = job
      @job_id = job[:id]
      @ws_client = ws_client
      @process = nil
    end

    def run_async
      Thread.new { run }
    end

    def run
      Logger.info("Starting job #{@job_id}: #{@job[:command]}")
      API.update_job_status(@job_id, status: "running")
      
      @@mutex.synchronize { @@running_jobs[@job_id] = self }
      
      output = []
      exit_code = nil

      begin
        IO.popen(@job[:command] + " 2>&1", "r") do |io|
          @process = io
          io.each_line do |line|
            output << line
            @ws_client.send_log_chunk(@job_id, line)
            
            # Also stream to API periodically
            if output.length % 10 == 0
              API.update_job_status(@job_id, status: "running", logs: output.last(50).join)
            end
          end
        end

        exit_code = $?.exitstatus
        status = exit_code == 0 ? "completed" : "failed"
        
        Logger.info("Job #{@job_id} finished with exit code #{exit_code}")
        API.update_job_status(@job_id, status: status, output: output.join, exit_code: exit_code)
        
      rescue => e
        Logger.error("Job #{@job_id} failed: #{e.message}")
        API.update_job_status(@job_id, status: "failed", output: output.join + "\nError: #{e.message}")
      ensure
        @@mutex.synchronize { @@running_jobs.delete(@job_id) }
      end
    end

    def kill
      return unless @process
      Logger.info("Killing job #{@job_id}")
      Process.kill("TERM", @process.pid) rescue nil
      sleep 2
      Process.kill("KILL", @process.pid) rescue nil
    end

    def self.kill(job_id)
      @@mutex.synchronize do
        runner = @@running_jobs[job_id]
        runner&.kill
      end
    end

    def self.running?(job_id)
      @@mutex.synchronize { @@running_jobs.key?(job_id) }
    end
  end

  class Heartbeat
    def initialize(agent_id, ws_client)
      @agent_id = agent_id
      @ws_client = ws_client
      @running = false
      @interval = 30
    end

    def start
      @running = true
      Logger.info("Starting heartbeat every #{@interval}s")
      
      @thread = Thread.new do
        while @running
          begin
            send_heartbeat
            sleep @interval
          rescue => e
            Logger.error("Heartbeat error: #{e.message}")
            sleep @interval
          end
        end
      end
    end

    def stop
      @running = false
      @thread&.join(5)
    end

    private

    def send_heartbeat
      jobs = JobRunner.instance_variable_get(:@@running_jobs).keys
      response = API.heartbeat(agent_id: @agent_id, status: @ws_client.connected? ? "online" : "disconnected", jobs: jobs)
      Logger.debug("Heartbeat sent: #{response.code}")
    end
  end
end
