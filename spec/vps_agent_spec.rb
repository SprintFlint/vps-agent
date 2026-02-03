# frozen_string_literal: true

require "spec_helper"
require "vps_agent"
require "fileutils"

RSpec.describe VPSAgent do
  it "has a version number" do
    expect(VPSAgent::VERSION).not_to be nil
    expect(VPSAgent::VERSION).to eq("0.1.0")
  end

  it "has a config directory" do
    expect(VPSAgent::CONFIG_DIR).to eq(File.expand_path("~/.vps-agent"))
  end

  it "has a config file path" do
    expect(VPSAgent::CONFIG_FILE).to end_with("config.json")
  end
end

RSpec.describe VPSAgent::Config do
  before(:each) do
    # Clean up any leftover test config
    test_config = File.join(File.expand_path("~/.vps-agent"), "test_config.json")
    @test_config = test_config
    allow(VPSAgent::Config).to receive(:config_file).and_return(test_config)
    FileUtils.rm_f(test_config)
  end

  after(:each) do
    FileUtils.rm_f(@test_config) if @test_config
  end

  describe ".load" do
    it "returns empty hash when no config exists" do
      expect(VPSAgent::Config.load).to eq({})
    end

    it "loads existing config" do
      FileUtils.mkdir_p(File.dirname(@test_config))
      File.write(@test_config, JSON.dump({ "agent_id" => "test123" }))
      expect(VPSAgent::Config.load[:agent_id]).to eq("test123")
    end
  end

  describe ".save" do
    it "saves config to file" do
      VPSAgent::Config.save({ key: "value" })
      expect(File).to exist(@test_config)
      expect(JSON.parse(File.read(@test_config))["key"]).to eq("value")
    end
  end

  describe ".get and .set" do
    it "sets and gets values" do
      VPSAgent::Config.set(:api_url, "https://test.com")
      expect(VPSAgent::Config.get(:api_url)).to eq("https://test.com")
      # Clean up
      VPSAgent::Config.set(:api_url, nil)
    end
  end
end

RSpec.describe VPSAgent::Logger do
  it "provides logging methods" do
    expect(VPSAgent::Logger).to respond_to(:info, :error, :debug)
  end
end
