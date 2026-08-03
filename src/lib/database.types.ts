export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      adder_rules: {
        Row: {
          amount: number
          amount_type: string
          condition: Json
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          priority: number
          updated_at: string
        }
        Insert: {
          amount: number
          amount_type?: string
          condition?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          priority?: number
          updated_at?: string
        }
        Update: {
          amount?: number
          amount_type?: string
          condition?: Json
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          priority?: number
          updated_at?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: Database["public"]["Enums"]["user_role"] | null
          context: Json
          entity_id: string | null
          entity_type: string
          id: number
          new_data: Json | null
          occurred_at: string
          old_data: Json | null
          project_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["user_role"] | null
          context?: Json
          entity_id?: string | null
          entity_type: string
          id?: never
          new_data?: Json | null
          occurred_at?: string
          old_data?: Json | null
          project_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["user_role"] | null
          context?: Json
          entity_id?: string | null
          entity_type?: string
          id?: never
          new_data?: Json | null
          occurred_at?: string
          old_data?: Json | null
          project_id?: string | null
        }
        Relationships: []
      }
      availability_slots: {
        Row: {
          created_at: string
          designer_id: string
          ends_at: string
          id: string
          project_id: string | null
          slot_type: string
          starts_at: string
          status: Database["public"]["Enums"]["slot_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          designer_id: string
          ends_at: string
          id?: string
          project_id?: string | null
          slot_type?: string
          starts_at: string
          status?: Database["public"]["Enums"]["slot_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          designer_id?: string
          ends_at?: string
          id?: string
          project_id?: string | null
          slot_type?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["slot_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_slots_designer_id_fkey"
            columns: ["designer_id"]
            isOneToOne: false
            referencedRelation: "designers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      bom_items: {
        Row: {
          created_at: string
          description: string
          design_id: string
          id: string
          price_book_id: string | null
          project_id: string
          quantity: number
          sku: string | null
          source: string
          unit_cost: number | null
          unit_price: number | null
          updated_at: string
          vendor_quote_id: string | null
        }
        Insert: {
          created_at?: string
          description: string
          design_id: string
          id?: string
          price_book_id?: string | null
          project_id: string
          quantity?: number
          sku?: string | null
          source?: string
          unit_cost?: number | null
          unit_price?: number | null
          updated_at?: string
          vendor_quote_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          design_id?: string
          id?: string
          price_book_id?: string | null
          project_id?: string
          quantity?: number
          sku?: string | null
          source?: string
          unit_cost?: number | null
          unit_price?: number | null
          updated_at?: string
          vendor_quote_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bom_items_design_id_fkey"
            columns: ["design_id"]
            isOneToOne: false
            referencedRelation: "designs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_items_price_book_id_fkey"
            columns: ["price_book_id"]
            isOneToOne: false
            referencedRelation: "price_book"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_items_vendor_quote_id_fkey"
            columns: ["vendor_quote_id"]
            isOneToOne: false
            referencedRelation: "vendor_quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      change_orders: {
        Row: {
          amount_delta: number
          approved_at: string | null
          approved_by: string | null
          created_at: string
          description: string | null
          document_id: string | null
          id: string
          number: number
          project_id: string
          reason: string | null
          requested_by: string | null
          requires_customer_signature: boolean
          status: Database["public"]["Enums"]["change_order_status"]
          updated_at: string
        }
        Insert: {
          amount_delta?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          description?: string | null
          document_id?: string | null
          id?: string
          number: number
          project_id: string
          reason?: string | null
          requested_by?: string | null
          requires_customer_signature?: boolean
          status?: Database["public"]["Enums"]["change_order_status"]
          updated_at?: string
        }
        Update: {
          amount_delta?: number
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          description?: string | null
          document_id?: string | null
          id?: string
          number?: number
          project_id?: string
          reason?: string | null
          requested_by?: string | null
          requires_customer_signature?: boolean
          status?: Database["public"]["Enums"]["change_order_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_orders_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_orders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_orders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_orders_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address: Json
          created_at: string
          dealer_id: string
          email: string | null
          first_name: string
          id: string
          last_name: string
          phone: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          address?: Json
          created_at?: string
          dealer_id: string
          email?: string | null
          first_name: string
          id?: string
          last_name: string
          phone?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          address?: Json
          created_at?: string
          dealer_id?: string
          email?: string | null
          first_name?: string
          id?: string
          last_name?: string
          phone?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_dealer_id_fkey"
            columns: ["dealer_id"]
            isOneToOne: false
            referencedRelation: "dealers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dealer_users: {
        Row: {
          created_at: string
          dealer_id: string
          is_owner: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          dealer_id: string
          is_owner?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          dealer_id?: string
          is_owner?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dealer_users_dealer_id_fkey"
            columns: ["dealer_id"]
            isOneToOne: false
            referencedRelation: "dealers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dealer_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      dealers: {
        Row: {
          address: Json
          code: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: Json
          code?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: Json
          code?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      design_assets: {
        Row: {
          created_at: string
          design_id: string
          document_id: string
          id: string
        }
        Insert: {
          created_at?: string
          design_id: string
          document_id: string
          id?: string
        }
        Update: {
          created_at?: string
          design_id?: string
          document_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "design_assets_design_id_fkey"
            columns: ["design_id"]
            isOneToOne: false
            referencedRelation: "designs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_assets_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      designers: {
        Row: {
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          max_concurrent_projects: number
          skills: string[]
          timezone: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          max_concurrent_projects?: number
          skills?: string[]
          timezone?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          max_concurrent_projects?: number
          skills?: string[]
          timezone?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "designers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      designs: {
        Row: {
          approved_at: string | null
          created_at: string
          designer_id: string | null
          id: string
          inverter_model: string | null
          layout: Json
          notes: string | null
          panel_count: number | null
          project_id: string
          status: Database["public"]["Enums"]["design_status"]
          submitted_at: string | null
          system_size_kw: number | null
          updated_at: string
          version: number
        }
        Insert: {
          approved_at?: string | null
          created_at?: string
          designer_id?: string | null
          id?: string
          inverter_model?: string | null
          layout?: Json
          notes?: string | null
          panel_count?: number | null
          project_id: string
          status?: Database["public"]["Enums"]["design_status"]
          submitted_at?: string | null
          system_size_kw?: number | null
          updated_at?: string
          version?: number
        }
        Update: {
          approved_at?: string | null
          created_at?: string
          designer_id?: string | null
          id?: string
          inverter_model?: string | null
          layout?: Json
          notes?: string | null
          panel_count?: number | null
          project_id?: string
          status?: Database["public"]["Enums"]["design_status"]
          submitted_at?: string | null
          system_size_kw?: number | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "designs_designer_id_fkey"
            columns: ["designer_id"]
            isOneToOne: false
            referencedRelation: "designers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "designs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "designs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          bucket: string
          created_at: string
          customer_visible: boolean
          id: string
          kind: Database["public"]["Enums"]["document_kind"]
          mime_type: string | null
          object_path: string
          project_id: string
          size_bytes: number | null
          title: string | null
          uploaded_by: string | null
        }
        Insert: {
          bucket: string
          created_at?: string
          customer_visible?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["document_kind"]
          mime_type?: string | null
          object_path: string
          project_id: string
          size_bytes?: number | null
          title?: string | null
          uploaded_by?: string | null
        }
        Update: {
          bucket?: string
          created_at?: string
          customer_visible?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["document_kind"]
          mime_type?: string | null
          object_path?: string
          project_id?: string
          size_bytes?: number | null
          title?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      exceptions: {
        Row: {
          assigned_to: string | null
          created_at: string
          details: Json
          entity_id: string | null
          entity_type: string | null
          id: string
          project_id: string | null
          raised_by: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: Database["public"]["Enums"]["exception_severity"]
          status: Database["public"]["Enums"]["exception_status"]
          summary: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          project_id?: string | null
          raised_by?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: Database["public"]["Enums"]["exception_severity"]
          status?: Database["public"]["Enums"]["exception_status"]
          summary: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          project_id?: string | null
          raised_by?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: Database["public"]["Enums"]["exception_severity"]
          status?: Database["public"]["Enums"]["exception_status"]
          summary?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exceptions_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exceptions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exceptions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exceptions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      jurisdictions: {
        Row: {
          ahj_code: string | null
          contact: Json
          county: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          requirements: Json
          state: string
          typical_turnaround_days: number | null
          updated_at: string
        }
        Insert: {
          ahj_code?: string | null
          contact?: Json
          county?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          requirements?: Json
          state: string
          typical_turnaround_days?: number | null
          updated_at?: string
        }
        Update: {
          ahj_code?: string | null
          contact?: Json
          county?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          requirements?: Json
          state?: string
          typical_turnaround_days?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      permit_events: {
        Row: {
          actor_id: string | null
          from_status: Database["public"]["Enums"]["permit_status"] | null
          id: number
          notes: string | null
          occurred_at: string
          permit_id: string
          to_status: Database["public"]["Enums"]["permit_status"]
        }
        Insert: {
          actor_id?: string | null
          from_status?: Database["public"]["Enums"]["permit_status"] | null
          id?: never
          notes?: string | null
          occurred_at?: string
          permit_id: string
          to_status: Database["public"]["Enums"]["permit_status"]
        }
        Update: {
          actor_id?: string | null
          from_status?: Database["public"]["Enums"]["permit_status"] | null
          id?: never
          notes?: string | null
          occurred_at?: string
          permit_id?: string
          to_status?: Database["public"]["Enums"]["permit_status"]
        }
        Relationships: [
          {
            foreignKeyName: "permit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permit_events_permit_id_fkey"
            columns: ["permit_id"]
            isOneToOne: false
            referencedRelation: "permits"
            referencedColumns: ["id"]
          },
        ]
      }
      permits: {
        Row: {
          approved_at: string | null
          created_at: string
          expires_at: string | null
          fees: number | null
          id: string
          jurisdiction_id: string
          notes: string | null
          permit_number: string | null
          permit_type: string
          project_id: string
          status: Database["public"]["Enums"]["permit_status"]
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          created_at?: string
          expires_at?: string | null
          fees?: number | null
          id?: string
          jurisdiction_id: string
          notes?: string | null
          permit_number?: string | null
          permit_type?: string
          project_id: string
          status?: Database["public"]["Enums"]["permit_status"]
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          created_at?: string
          expires_at?: string | null
          fees?: number | null
          id?: string
          jurisdiction_id?: string
          notes?: string | null
          permit_number?: string | null
          permit_type?: string
          project_id?: string
          status?: Database["public"]["Enums"]["permit_status"]
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "permits_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permits_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permits_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      price_book: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          effective_from: string | null
          effective_to: string | null
          id: string
          is_active: boolean
          manufacturer: string | null
          metadata: Json
          name: string
          sku: string
          unit: string
          unit_cost: number | null
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          manufacturer?: string | null
          metadata?: Json
          name: string
          sku: string
          unit?: string
          unit_cost?: number | null
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          manufacturer?: string | null
          metadata?: Json
          name?: string
          sku?: string
          unit?: string
          unit_cost?: number | null
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          is_active: boolean
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          is_active?: boolean
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      project_adders: {
        Row: {
          adder_rule_id: string | null
          amount: number
          amount_type: string
          approved: boolean
          created_at: string
          created_by: string | null
          id: string
          name: string
          project_id: string
          source: string
        }
        Insert: {
          adder_rule_id?: string | null
          amount: number
          amount_type?: string
          approved?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          project_id: string
          source?: string
        }
        Update: {
          adder_rule_id?: string | null
          amount?: number
          amount_type?: string
          approved?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          project_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_adders_adder_rule_id_fkey"
            columns: ["adder_rule_id"]
            isOneToOne: false
            referencedRelation: "adder_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_adders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_adders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_adders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_stage_events: {
        Row: {
          changed_at: string
          changed_by: string | null
          from_stage: Database["public"]["Enums"]["project_stage"] | null
          id: number
          notes: string | null
          project_id: string
          to_stage: Database["public"]["Enums"]["project_stage"]
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          from_stage?: Database["public"]["Enums"]["project_stage"] | null
          id?: never
          notes?: string | null
          project_id: string
          to_stage: Database["public"]["Enums"]["project_stage"]
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          from_stage?: Database["public"]["Enums"]["project_stage"] | null
          id?: never
          notes?: string | null
          project_id?: string
          to_stage?: Database["public"]["Enums"]["project_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "project_stage_events_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_stage_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_stage_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          amount_invoiced: number
          amount_paid: number
          assigned_designer_id: string | null
          client_id: string
          code: string
          contract_value: number | null
          created_at: string
          created_by: string | null
          dealer_fee: number | null
          dealer_id: string
          id: string
          jurisdiction_id: string | null
          metadata: Json
          name: string
          panel_count: number | null
          priority: number
          site_address: Json
          stage: Database["public"]["Enums"]["project_stage"]
          status: Database["public"]["Enums"]["project_status"]
          system_size_kw: number | null
          target_install_date: string | null
          updated_at: string
          utility_id: string | null
        }
        Insert: {
          amount_invoiced?: number
          amount_paid?: number
          assigned_designer_id?: string | null
          client_id: string
          code?: string
          contract_value?: number | null
          created_at?: string
          created_by?: string | null
          dealer_fee?: number | null
          dealer_id: string
          id?: string
          jurisdiction_id?: string | null
          metadata?: Json
          name: string
          panel_count?: number | null
          priority?: number
          site_address?: Json
          stage?: Database["public"]["Enums"]["project_stage"]
          status?: Database["public"]["Enums"]["project_status"]
          system_size_kw?: number | null
          target_install_date?: string | null
          updated_at?: string
          utility_id?: string | null
        }
        Update: {
          amount_invoiced?: number
          amount_paid?: number
          assigned_designer_id?: string | null
          client_id?: string
          code?: string
          contract_value?: number | null
          created_at?: string
          created_by?: string | null
          dealer_fee?: number | null
          dealer_id?: string
          id?: string
          jurisdiction_id?: string | null
          metadata?: Json
          name?: string
          panel_count?: number | null
          priority?: number
          site_address?: Json
          stage?: Database["public"]["Enums"]["project_stage"]
          status?: Database["public"]["Enums"]["project_status"]
          system_size_kw?: number | null
          target_install_date?: string | null
          updated_at?: string
          utility_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_assigned_designer_id_fkey"
            columns: ["assigned_designer_id"]
            isOneToOne: false
            referencedRelation: "designers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_dealer_id_fkey"
            columns: ["dealer_id"]
            isOneToOne: false
            referencedRelation: "dealers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_jurisdiction_id_fkey"
            columns: ["jurisdiction_id"]
            isOneToOne: false
            referencedRelation: "jurisdictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_utility_id_fkey"
            columns: ["utility_id"]
            isOneToOne: false
            referencedRelation: "utilities"
            referencedColumns: ["id"]
          },
        ]
      }
      site_surveys: {
        Row: {
          completed_at: string | null
          created_at: string
          findings: Json
          id: string
          project_id: string
          scheduled_at: string | null
          slot_id: string | null
          surveyor: string | null
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          findings?: Json
          id?: string
          project_id: string
          scheduled_at?: string | null
          slot_id?: string | null
          surveyor?: string | null
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          findings?: Json
          id?: string
          project_id?: string
          scheduled_at?: string | null
          slot_id?: string | null
          surveyor?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_surveys_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_surveys_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_surveys_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      stage_feedback: {
        Row: {
          created_at: string
          created_by: string | null
          feedback: string | null
          id: string
          project_id: string
          rating: number | null
          source: string
          stage: Database["public"]["Enums"]["project_stage"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          feedback?: string | null
          id?: string
          project_id: string
          rating?: number | null
          source?: string
          stage: Database["public"]["Enums"]["project_stage"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
          feedback?: string | null
          id?: string
          project_id?: string
          rating?: number | null
          source?: string
          stage?: Database["public"]["Enums"]["project_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "stage_feedback_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_feedback_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stage_feedback_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      utilities: {
        Row: {
          created_at: string
          id: string
          interconnection_requirements: Json
          is_active: boolean
          name: string
          state: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          interconnection_requirements?: Json
          is_active?: boolean
          name: string
          state: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          interconnection_requirements?: Json
          is_active?: boolean
          name?: string
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      vendor_quotes: {
        Row: {
          created_at: string
          document_id: string | null
          id: string
          line_items: Json
          project_id: string | null
          quote_number: string | null
          received_at: string | null
          requested_by: string | null
          status: Database["public"]["Enums"]["vendor_quote_status"]
          total: number | null
          updated_at: string
          valid_until: string | null
          vendor_id: string
        }
        Insert: {
          created_at?: string
          document_id?: string | null
          id?: string
          line_items?: Json
          project_id?: string | null
          quote_number?: string | null
          received_at?: string | null
          requested_by?: string | null
          status?: Database["public"]["Enums"]["vendor_quote_status"]
          total?: number | null
          updated_at?: string
          valid_until?: string | null
          vendor_id: string
        }
        Update: {
          created_at?: string
          document_id?: string | null
          id?: string
          line_items?: Json
          project_id?: string | null
          quote_number?: string | null
          received_at?: string | null
          requested_by?: string | null
          status?: Database["public"]["Enums"]["vendor_quote_status"]
          total?: number | null
          updated_at?: string
          valid_until?: string | null
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_quotes_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_quotes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_financials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_quotes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_quotes_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_quotes_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          categories: string[]
          contact: Json
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          categories?: string[]
          contact?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          categories?: string[]
          contact?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      project_financials: {
        Row: {
          amount_invoiced: number | null
          amount_paid: number | null
          client_id: string | null
          code: string | null
          contract_value: number | null
          created_at: string | null
          dealer_fee: number | null
          dealer_id: string | null
          id: string | null
          name: string | null
          stage: Database["public"]["Enums"]["project_stage"] | null
          status: Database["public"]["Enums"]["project_status"] | null
          system_size_kw: number | null
          target_install_date: string | null
          updated_at: string | null
        }
        Insert: {
          amount_invoiced?: number | null
          amount_paid?: number | null
          client_id?: string | null
          code?: string | null
          contract_value?: number | null
          created_at?: string | null
          dealer_fee?: number | null
          dealer_id?: string | null
          id?: string | null
          name?: string | null
          stage?: Database["public"]["Enums"]["project_stage"] | null
          status?: Database["public"]["Enums"]["project_status"] | null
          system_size_kw?: number | null
          target_install_date?: string | null
          updated_at?: string | null
        }
        Update: {
          amount_invoiced?: number | null
          amount_paid?: number | null
          client_id?: string | null
          code?: string | null
          contract_value?: number | null
          created_at?: string | null
          dealer_fee?: number | null
          dealer_id?: string | null
          id?: string | null
          name?: string | null
          stage?: Database["public"]["Enums"]["project_stage"] | null
          status?: Database["public"]["Enums"]["project_status"] | null
          system_size_kw?: number | null
          target_install_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_dealer_id_fkey"
            columns: ["dealer_id"]
            isOneToOne: false
            referencedRelation: "dealers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      log_audit_event: {
        Args: {
          p_action: string
          p_context?: Json
          p_entity_id?: string
          p_entity_type: string
          p_project_id?: string
        }
        Returns: number
      }
    }
    Enums: {
      change_order_status:
        "draft" | "pending_approval" | "approved" | "rejected" | "void"
      design_status:
        "draft" | "in_review" | "approved" | "rejected" | "superseded"
      document_kind:
        "dwg" | "pdf" | "photo" | "contract" | "permit_doc" | "other"
      exception_severity: "low" | "medium" | "high" | "critical"
      exception_status:
        "open" | "acknowledged" | "in_progress" | "resolved" | "dismissed"
      permit_status:
        | "not_started"
        | "preparing"
        | "submitted"
        | "in_review"
        | "revisions_required"
        | "approved"
        | "rejected"
        | "expired"
      project_stage:
        | "intake"
        | "site_survey"
        | "design"
        | "design_review"
        | "engineering"
        | "permitting"
        | "permit_approved"
        | "installation"
        | "inspection"
        | "pto"
        | "complete"
      project_status: "active" | "on_hold" | "cancelled" | "complete"
      slot_status: "open" | "held" | "booked" | "cancelled"
      user_role: "admin" | "designer" | "customer" | "dealer" | "finance"
      vendor_quote_status:
        "requested" | "received" | "accepted" | "declined" | "expired"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      change_order_status: [
        "draft",
        "pending_approval",
        "approved",
        "rejected",
        "void",
      ],
      design_status: [
        "draft",
        "in_review",
        "approved",
        "rejected",
        "superseded",
      ],
      document_kind: ["dwg", "pdf", "photo", "contract", "permit_doc", "other"],
      exception_severity: ["low", "medium", "high", "critical"],
      exception_status: [
        "open",
        "acknowledged",
        "in_progress",
        "resolved",
        "dismissed",
      ],
      permit_status: [
        "not_started",
        "preparing",
        "submitted",
        "in_review",
        "revisions_required",
        "approved",
        "rejected",
        "expired",
      ],
      project_stage: [
        "intake",
        "site_survey",
        "design",
        "design_review",
        "engineering",
        "permitting",
        "permit_approved",
        "installation",
        "inspection",
        "pto",
        "complete",
      ],
      project_status: ["active", "on_hold", "cancelled", "complete"],
      slot_status: ["open", "held", "booked", "cancelled"],
      user_role: ["admin", "designer", "customer", "dealer", "finance"],
      vendor_quote_status: [
        "requested",
        "received",
        "accepted",
        "declined",
        "expired",
      ],
    },
  },
} as const
