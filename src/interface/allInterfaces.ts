export interface LoginRequestBody {
  email: string;
  password: string;
}

export interface RegisterRequestBody {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface AuthResponse {
  status: "success" | "fail" | "error";
  message?: string;
  data?: {
    admin?: any;
  };
  details?: string;
  stack?: string;
}

export interface ProduceRequestBody {
  readonly produceId?: string;
  produceName?: string;
  isFeatured?: boolean;
  title?: string;
  totalUnit?: number;
  duration?: number;
  minimumUnit?: number;
  ROI?: number;
  description?: string;
  price?: number;
  category?: "crops" | "livestock" | "aquaculture";
}

export interface producerOnboardRequestBody {
  farmName?: string;
  nin?: string;
  address?: string;
  referees?: string;
}

export interface RefereeInput {
  fullName?: string;
  phone?: string;
  nin?: string;
  guarantorPhoto?: {
    publicId: string;
    url: string;
  };
}

export interface OnboardProducerData {
  farmName?: string;
  nin?: string;
  address?: string;
  referees: RefereeInput[];
}

export interface PaystackInitializeTransactionPayload {
  email: string;
  amount: number; // in kobo
  reference: string;
  callback_url: string;
  metadata?: Record<string, any>;
}

export interface PaystackInitializeResponse {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    status: string;
    reference: string;
    amount: number;
    currency: string;
    customer: {
      email: string;
    };
  };
}

export interface PaystackEventData {
  reference: string;
  paid_at: string; // ISO date string
  metadata: {
    units: number;
    produce_title: string;
  };
}

// export const verifyTransaction = async (reference: string) => {
//   const response = await paystack.get<PaystackVerifyResponse>(
//     `/transaction/verify/${reference}`,
//   );

//   return response.data;
// };
