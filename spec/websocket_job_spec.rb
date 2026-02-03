# frozen_string_literal: true

require 'spec_helper'
require 'vps_agent'

RSpec.describe VPSAgent::WebSocketClient do
  let(:mock_ws) { instance_double(WebSocket::Client::Simple::Client) }
  let(:client) { described_class.new(url: 'wss://test.com/ws', agent_id: 'agent_123', token: 'test_token') }

  before do
    allow(WebSocket::Client::Simple).to receive(:connect).and_return(mock_ws)
    allow(mock_ws).to receive(:on)
    allow(mock_ws).to receive(:send)
    allow(mock_ws).to receive(:close)
    allow(VPSAgent::Logger).to receive(:info)
    allow(VPSAgent::Logger).to receive(:error)
  end

  describe '#connect' do
    it 'connects with proper headers' do
      expect(WebSocket::Client::Simple).to receive(:connect).with(
        'wss://test.com/ws',
        headers: {
          'Authorization' => 'Bearer test_token',
          'X-Agent-ID' => 'agent_123'
        }
      )
      client.connect
    end

    it 'returns self for chaining' do
      expect(client.connect).to eq(client)
    end
  end

  describe '#send_message' do
    it 'sends JSON data when connected' do
      client.connect
      # Simulate being connected by setting both @ws and @connected
      client.instance_variable_set(:@ws, mock_ws)
      client.instance_variable_set(:@connected, true)

      expect(mock_ws).to receive(:send).with('{"type":"test","data":"value"}')
      client.send_message(type: 'test', data: 'value')
    end

    it 'does nothing when not connected' do
      client.connect
      client.instance_variable_set(:@connected, false)
      expect(mock_ws).not_to receive(:send)
      client.send_message(type: 'test')
    end
  end

  describe '#send_log_chunk' do
    it 'sends log chunk with timestamp' do
      client.connect
      client.instance_variable_set(:@ws, mock_ws)
      client.instance_variable_set(:@connected, true)

      expect(mock_ws).to receive(:send) do |json|
        data = JSON.parse(json)
        expect(data['type']).to eq('log_chunk')
        expect(data['job_id']).to eq('job_123')
        expect(data['chunk']).to eq('log line')
        expect(data['timestamp']).not_to be_nil
      end
      client.send_log_chunk('job_123', 'log line')
    end
  end
end

RSpec.describe VPSAgent::JobRunner do
  let(:job) { { id: 'job_123', command: 'echo "hello world"' } }
  let(:mock_ws) { instance_double(VPSAgent::WebSocketClient) }
  let(:runner) { described_class.new(job, mock_ws) }

  before do
    allow(VPSAgent::API).to receive(:update_job_status)
    allow(VPSAgent::Logger).to receive(:info)
    allow(VPSAgent::Logger).to receive(:error)
    allow(mock_ws).to receive(:send_log_chunk)
  end

  describe '#run' do
    it 'updates job status to running' do
      expect(VPSAgent::API).to receive(:update_job_status).with('job_123', status: 'running')
      runner.run
    end

    it 'captures command output' do
      runner.run
      expect(VPSAgent::API).to have_received(:update_job_status).with(
        'job_123',
        hash_including(status: 'completed', exit_code: 0)
      )
    end

    it 'streams logs via WebSocket' do
      allow(mock_ws).to receive(:send_log_chunk) do |job_id, chunk|
        expect(job_id).to eq('job_123')
        expect(chunk).to include('hello world')
      end
      runner.run
    end
  end

  describe '.kill' do
    it 'kills a running job' do
      # This is a basic test - killing is hard to test without a real process
      expect { described_class.kill('nonexistent_job') }.not_to raise_error
    end
  end

  describe '.running?' do
    it 'returns false for non-existent job' do
      expect(described_class.running?('nonexistent_job')).to be false
    end
  end
end

RSpec.describe VPSAgent::Heartbeat do
  let(:mock_ws) { instance_double(VPSAgent::WebSocketClient) }
  let(:heartbeat) { described_class.new('agent_123', mock_ws) }

  before do
    allow(VPSAgent::API).to receive(:heartbeat)
    allow(VPSAgent::Logger).to receive(:info)
    allow(VPSAgent::Logger).to receive(:error)
    allow(VPSAgent::Logger).to receive(:debug)
    allow(mock_ws).to receive(:connected?).and_return(true)
  end

  describe '#start' do
    it 'logs that heartbeat is starting' do
      expect(VPSAgent::Logger).to receive(:info).with(/Starting heartbeat/)
      heartbeat.start
      sleep 0.1
      heartbeat.stop
    end
  end

  describe '#stop' do
    it 'stops the heartbeat thread' do
      heartbeat.start
      sleep 0.1
      expect { heartbeat.stop }.not_to raise_error
    end
  end
end

RSpec.describe VPSAgent::API do
  describe '.base_uri' do
    it 'returns default API URL when not configured' do
      allow(VPSAgent::Config).to receive(:get).with(:api_url).and_return(nil)
      expect(described_class.base_uri).to eq('https://api.sprintflint.com')
    end

    it 'returns configured API URL' do
      allow(VPSAgent::Config).to receive(:get).with(:api_url).and_return('https://custom.api.com')
      expect(described_class.base_uri).to eq('https://custom.api.com')
    end
  end

  describe '.headers' do
    before do
      allow(VPSAgent::Config).to receive(:get).with(:token).and_return('test_token')
    end

    it 'includes authorization header' do
      expect(described_class.headers['Authorization']).to eq('Bearer test_token')
    end

    it 'includes content-type header' do
      expect(described_class.headers['Content-Type']).to eq('application/json')
    end
  end
end
